import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaClient, AlanaRequestError } from './alana.client';
import {
  canonicalJson,
  DESTINATION_ID_PATTERN,
  DESTINATION_SECRET_ID_PATTERN,
  DESTINATION_VERSION_PATTERN,
  MAX_DESTINATIONS,
  type DestinationSelectionPayload,
  type SafeAlanaState,
} from './broadcast-destinations.types';

type CatalogInput = {
  id?: unknown;
  displayName?: unknown;
  secretId?: unknown;
  secretVersionId?: unknown;
};

type CommandInput = {
  commandId?: unknown;
  destinationIds?: unknown;
  selectionVersion?: unknown;
  confirmed?: unknown;
};

type StoredCommand = Prisma.BroadcastDestinationCommandGetPayload<{
  include: {
    selection: { include: { destinations: true } };
  };
}>;

@Injectable()
export class BroadcastDestinationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alana: AlanaClient,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async listDestinations() {
    const destinations = await this.prisma.broadcastDestination.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return destinations.map((destination) => ({
      id: destination.id,
      displayName: destination.displayName,
      position: destination.position,
      retired: destination.retiredAt !== null,
    }));
  }

  async listCatalog() {
    const destinations = await this.prisma.broadcastDestination.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return destinations.map((destination) => ({
      id: destination.id,
      displayName: destination.displayName,
      secretId: destination.secretId,
      secretVersionId: destination.secretVersionId,
      position: destination.position,
      retiredAt: destination.retiredAt,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    }));
  }

  async createDestination(input: CatalogInput) {
    const normalized = normalizeCatalogInput(input, true);
    const position = await this.prisma.broadcastDestination.count();
    try {
      return await this.prisma.broadcastDestination.create({
        data: { ...normalized, position },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Destination ID already exists');
      }
      throw error;
    }
  }

  async updateDestination(destinationId: string, input: CatalogInput) {
    validateDestinationId(destinationId);
    const normalized = normalizeCatalogInput(
      { ...input, id: destinationId },
      false,
    );
    try {
      return await this.prisma.broadcastDestination.update({
        where: { id: destinationId },
        data: {
          displayName: normalized.displayName,
          secretId: normalized.secretId,
          secretVersionId: normalized.secretVersionId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Destination not found');
      }
      throw error;
    }
  }

  async setRetired(destinationId: string, retired: boolean) {
    validateDestinationId(destinationId);
    try {
      return await this.prisma.broadcastDestination.update({
        where: { id: destinationId },
        data: { retiredAt: retired ? new Date() : null },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Destination not found');
      }
      throw error;
    }
  }

  async reorderDestinations(rawIds: unknown) {
    if (!Array.isArray(rawIds) || rawIds.length > 100) {
      throw new BadRequestException('A bounded destination order is required');
    }
    const ids = rawIds.map((id) => {
      if (typeof id !== 'string') {
        throw new BadRequestException('Destination order is invalid');
      }
      validateDestinationId(id);
      return id;
    });
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Destination order contains duplicates');
    }
    const known = await this.prisma.broadcastDestination.findMany({
      select: { id: true },
    });
    if (
      known.length !== ids.length ||
      known.some((destination) => !ids.includes(destination.id))
    ) {
      throw new BadRequestException(
        'Destination order must include the complete catalog',
      );
    }
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.broadcastDestination.update({
          where: { id },
          data: { position },
        }),
      ),
    );
    return this.listCatalog();
  }

  async getProgramState(programId: string) {
    await this.requireTelevisionProgram(programId);
    const destinations = await this.listDestinations();
    try {
      const downstream = await this.alana.status(programId);
      await this.reconcileRuntime(programId, downstream);
      return {
        programId,
        available: true,
        destinations,
        downstream: this.decorateState(downstream, destinations),
      };
    } catch (error) {
      if (!(error instanceof AlanaRequestError)) throw error;
      return {
        programId,
        available: false,
        destinations,
        downstream: this.decorateState(error.state, destinations),
      };
    }
  }

  async reload(programId: string, input: CommandInput, actorSubject: string) {
    const parsed = parseCommandInput(input, true);
    await this.requireTelevisionProgram(programId);
    let status: SafeAlanaState;
    try {
      status = await this.alana.status(programId);
    } catch (error) {
      throw this.toHttpError(error);
    }
    if (
      status.requestedState !== 'stopped' ||
      status.actualState !== 'stopped' ||
      status.transition !== null
    ) {
      throw new ConflictException(
        'Destination reload requires the television broadcast to be stopped',
      );
    }
    const requestHash = commandRequestHash('reload', parsed);
    const command = await this.prepareCommand(
      programId,
      'reload',
      parsed,
      requestHash,
      actorSubject,
      status.lastSequence,
    );
    if (command.status === 'succeeded')
      return this.commandResult(command, true);

    const selection = selectionPayload(command);
    try {
      const downstream = await this.alana.reload(
        programId,
        `${command.id}:reload`,
        selection,
      );
      assertSelectionAcknowledged(downstream.pendingDestinations, selection);
      return await this.finishCommand(command, downstream, 'succeeded', {
        requestedState: 'stopped',
        actualState: 'stopped',
        pendingSelectionId: command.selectionId,
      });
    } catch (error) {
      await this.failCommand(command.id, error);
      throw this.toHttpError(error);
    }
  }

  async start(programId: string, input: CommandInput, actorSubject: string) {
    const parsed = parseCommandInput(input, true);
    await this.requireTelevisionProgram(programId);
    const requestHash = commandRequestHash('start', parsed);
    let status: SafeAlanaState;
    try {
      status = await this.alana.status(programId);
    } catch (error) {
      throw this.toHttpError(error);
    }
    const command = await this.prepareCommand(
      programId,
      'start',
      parsed,
      requestHash,
      actorSubject,
      status.lastSequence,
    );
    if (command.status === 'succeeded')
      return this.commandResult(command, true);

    const selection = selectionPayload(command);
    try {
      if (
        status.requestedState === 'stopped' &&
        status.actualState === 'stopped'
      ) {
        const reloaded = await this.alana.reload(
          programId,
          `${command.id}:reload`,
          selection,
        );
        assertSelectionAcknowledged(reloaded.pendingDestinations, selection);
      }
      const downstream = await this.alana.start(
        programId,
        command.id,
        command.sequence,
        selection,
      );
      if (
        downstream.requestedState !== 'running' ||
        downstream.actualState !== 'running'
      ) {
        throw new AlanaRequestError(502, {
          ...downstream,
          error: 'Alana did not acknowledge Running',
        });
      }
      assertSelectionAcknowledged(downstream.activeDestinations, selection);
      return await this.finishCommand(command, downstream, 'succeeded', {
        requestedState: 'running',
        actualState: 'running',
        activeSelectionId: command.selectionId,
        pendingSelectionId: null,
      });
    } catch (error) {
      await this.failCommand(command.id, error);
      throw this.toHttpError(error);
    }
  }

  async stop(programId: string, input: CommandInput, actorSubject: string) {
    const parsed = parseCommandInput(input, false);
    await this.requireTelevisionProgram(programId);
    const requestHash = commandRequestHash('stop', parsed);
    let status: SafeAlanaState;
    try {
      status = await this.alana.status(programId);
    } catch (error) {
      throw this.toHttpError(error);
    }
    const command = await this.prepareCommand(
      programId,
      'stop',
      parsed,
      requestHash,
      actorSubject,
      status.lastSequence,
    );
    if (command.status === 'succeeded')
      return this.commandResult(command, true);
    try {
      const downstream = await this.alana.stop(
        programId,
        command.id,
        command.sequence,
      );
      if (
        downstream.requestedState !== 'stopped' ||
        downstream.actualState !== 'stopped'
      ) {
        throw new AlanaRequestError(502, {
          ...downstream,
          error: 'Alana did not acknowledge Stopped',
        });
      }
      return await this.finishCommand(command, downstream, 'succeeded', {
        requestedState: 'stopped',
        actualState: 'stopped',
        activeSelectionId: null,
      });
    } catch (error) {
      await this.failCommand(command.id, error);
      throw this.toHttpError(error);
    }
  }

  private async requireTelevisionProgram(programId: string) {
    const program = await this.prisma.programState.findUnique({
      where: { programId },
      select: { programId: true, type: true },
    });
    if (!program) throw new NotFoundException('Program not found');
    if (program.type !== 'tv' && program.type !== 'both') {
      throw new BadRequestException(
        'Destination selection applies only to a television program leg',
      );
    }
    return program;
  }

  private async prepareCommand(
    programId: string,
    action: string,
    input: ParsedCommandInput,
    requestHash: string,
    actorSubject: string,
    downstreamSequence: number,
  ): Promise<StoredCommand> {
    const prior = await this.prisma.broadcastDestinationCommand.findUnique({
      where: { id: input.commandId },
      include: { selection: { include: { destinations: true } } },
    });
    if (prior) {
      if (
        prior.programId !== programId ||
        prior.action !== action ||
        prior.requestHash !== requestHash
      ) {
        throw new ConflictException(
          'Command ID was already used for a different request',
        );
      }
      return prior;
    }

    const selection =
      action === 'stop'
        ? null
        : await this.resolveSelection(
            programId,
            input.destinationIds,
            input.selectionVersion,
            actorSubject,
          );

    return this.prisma.$transaction(
      async (transaction) => {
        const runtime = await transaction.broadcastDestinationRuntime.upsert({
          where: { programId },
          create: {
            programId,
            nextSequence: Math.max(1, downstreamSequence + 1),
          },
          update: {},
        });
        const sequence = Math.max(runtime.nextSequence, downstreamSequence + 1);
        await transaction.broadcastDestinationRuntime.update({
          where: { programId },
          data: { nextSequence: sequence + 1 },
        });
        return transaction.broadcastDestinationCommand.create({
          data: {
            id: input.commandId,
            programId,
            action,
            requestHash,
            sequence,
            selectionId: selection?.id,
            actorSubject,
            status: 'pending',
          },
          include: { selection: { include: { destinations: true } } },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async resolveSelection(
    programId: string,
    destinationIds: string[],
    selectionVersion: string | null,
    actorSubject: string,
  ) {
    if (selectionVersion) {
      const existing =
        await this.prisma.broadcastDestinationSelection.findUnique({
          where: { version: selectionVersion },
          include: { destinations: true },
        });
      if (!existing || existing.programId !== programId) {
        throw new NotFoundException('Destination selection not found');
      }
      const existingIds = existing.destinations
        .sort((left, right) => left.position - right.position)
        .map((destination) => destination.destinationId);
      if (!sameSet(existingIds, destinationIds)) {
        throw new ConflictException(
          'Selection version does not match the confirmed destinations',
        );
      }
      await this.assertCurrentlySelectable(existingIds);
      return existing;
    }

    const destinations = await this.assertCurrentlySelectable(destinationIds);
    const version = `destinations-${Date.now()}-${randomUUID()}`;
    const payload: DestinationSelectionPayload = {
      version,
      destinations: destinations.map((destination) => ({
        id: destination.id,
        secretId: destination.secretId,
        versionId: destination.secretVersionId,
      })),
    };
    const selectionHash = createHash('sha256')
      .update(canonicalJson(payload))
      .digest('hex');
    return this.prisma.broadcastDestinationSelection.create({
      data: {
        version,
        programId,
        selectionHash,
        createdBySubject: actorSubject,
        destinations: {
          create: destinations.map((destination, position) => ({
            destinationId: destination.id,
            displayName: destination.displayName,
            secretId: destination.secretId,
            secretVersionId: destination.secretVersionId,
            position,
          })),
        },
      },
      include: { destinations: true },
    });
  }

  private async assertCurrentlySelectable(destinationIds: string[]) {
    if (
      destinationIds.length < 1 ||
      destinationIds.length > MAX_DESTINATIONS ||
      new Set(destinationIds).size !== destinationIds.length
    ) {
      throw new BadRequestException(
        'Select between 1 and 20 unique destinations',
      );
    }
    destinationIds.forEach(validateDestinationId);
    const destinations = await this.prisma.broadcastDestination.findMany({
      where: { id: { in: destinationIds }, retiredAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    if (destinations.length !== destinationIds.length) {
      throw new BadRequestException(
        'Every selected destination must exist and not be retired',
      );
    }
    return destinations;
  }

  private async finishCommand(
    command: StoredCommand,
    downstream: SafeAlanaState,
    status: string,
    runtime: {
      requestedState: string;
      actualState: string;
      pendingSelectionId?: string | null;
      activeSelectionId?: string | null;
    },
  ) {
    const updated = await this.prisma.$transaction(async (transaction) => {
      const stored = await transaction.broadcastDestinationCommand.update({
        where: { id: command.id },
        data: {
          status,
          downstreamStatus: downstream as unknown as Prisma.InputJsonValue,
        },
        include: { selection: { include: { destinations: true } } },
      });
      await transaction.broadcastDestinationRuntime.upsert({
        where: { programId: command.programId },
        create: {
          programId: command.programId,
          nextSequence: command.sequence + 1,
          ...runtime,
        },
        update: runtime,
      });
      return stored;
    });
    this.metrics.recordBroadcastDestination(command.action, status);
    return this.commandResult(updated, false);
  }

  private async failCommand(commandId: string, error: unknown) {
    const downstream =
      error instanceof AlanaRequestError
        ? error.state
        : {
            requestedState: 'unknown',
            actualState: 'unknown',
            error: 'downstream request failed',
          };
    await this.prisma.broadcastDestinationCommand.update({
      where: { id: commandId },
      data: {
        status: 'failed',
        downstreamStatus: downstream as Prisma.InputJsonValue,
      },
    });
    this.metrics.recordBroadcastDestination('command', 'failed');
  }

  private commandResult(command: StoredCommand, duplicate: boolean) {
    return {
      commandId: command.id,
      action: command.action,
      sequence: command.sequence,
      status: command.status,
      selectionVersion: command.selection?.version ?? null,
      selectionHash: command.selection?.selectionHash ?? null,
      destinationIds:
        command.selection?.destinations
          .sort((left, right) => left.position - right.position)
          .map((destination) => destination.destinationId) ?? [],
      downstream: command.downstreamStatus ?? null,
      duplicate,
    };
  }

  private async reconcileRuntime(
    programId: string,
    downstream: SafeAlanaState,
  ) {
    const current = await this.prisma.broadcastDestinationRuntime.findUnique({
      where: { programId },
      select: { nextSequence: true },
    });
    const nextSequence = Math.max(
      current?.nextSequence ?? 1,
      downstream.lastSequence + 1,
    );
    await this.prisma.broadcastDestinationRuntime.upsert({
      where: { programId },
      create: {
        programId,
        nextSequence,
        requestedState: downstream.requestedState,
        actualState: downstream.actualState,
      },
      update: {
        nextSequence,
        requestedState: downstream.requestedState,
        actualState: downstream.actualState,
      },
    });
  }

  private decorateState(
    state: SafeAlanaState,
    destinations: Array<{ id: string; displayName: string }>,
  ) {
    const displayNames = new Map(
      destinations.map((destination) => [
        destination.id,
        destination.displayName,
      ]),
    );
    return {
      ...state,
      destinations: state.destinations.map((destination) => ({
        ...destination,
        displayName: displayNames.get(destination.id) ?? destination.id,
      })),
    };
  }

  private toHttpError(error: unknown) {
    if (!(error instanceof AlanaRequestError)) {
      return new BadGatewayException('Broadcast executor request failed');
    }
    const payload = {
      error: error.message,
      downstream: error.state,
    };
    if (error.status === 409) return new ConflictException(payload);
    if (error.status === 503) return new ServiceUnavailableException(payload);
    return new BadGatewayException(payload);
  }
}

type ParsedCommandInput = {
  commandId: string;
  destinationIds: string[];
  selectionVersion: string | null;
};

function parseCommandInput(
  input: CommandInput,
  destinationsRequired: boolean,
): ParsedCommandInput {
  if (
    typeof input.commandId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.commandId)
  ) {
    throw new BadRequestException('A stable bounded command ID is required');
  }
  if (input.confirmed !== true) {
    throw new BadRequestException('The broadcast action must be confirmed');
  }
  const destinationIds = Array.isArray(input.destinationIds)
    ? input.destinationIds.map((id) => {
        if (typeof id !== 'string') {
          throw new BadRequestException('Destination selection is invalid');
        }
        return id;
      })
    : [];
  if (destinationsRequired && destinationIds.length === 0) {
    throw new BadRequestException('Select at least one destination');
  }
  if (!destinationsRequired && destinationIds.length > 0) {
    throw new BadRequestException('Stop does not accept destinations');
  }
  const selectionVersion =
    typeof input.selectionVersion === 'string' && input.selectionVersion
      ? input.selectionVersion
      : null;
  if (selectionVersion && !DESTINATION_VERSION_PATTERN.test(selectionVersion)) {
    throw new BadRequestException('Selection version is invalid');
  }
  return { commandId: input.commandId, destinationIds, selectionVersion };
}

function normalizeCatalogInput(input: CatalogInput, includeId: boolean) {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (includeId || id) validateDestinationId(id);
  const displayName =
    typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const secretId =
    typeof input.secretId === 'string' ? input.secretId.trim() : '';
  const secretVersionId =
    typeof input.secretVersionId === 'string'
      ? input.secretVersionId.trim()
      : '';
  if (!displayName || displayName.length > 100) {
    throw new BadRequestException('Display name must contain 1-100 characters');
  }
  if (!DESTINATION_SECRET_ID_PATTERN.test(secretId)) {
    throw new BadRequestException('Secrets Manager reference is invalid');
  }
  if (!DESTINATION_VERSION_PATTERN.test(secretVersionId)) {
    throw new BadRequestException('Secret version ID is invalid');
  }
  return { id, displayName, secretId, secretVersionId };
}

function validateDestinationId(destinationId: string) {
  if (!DESTINATION_ID_PATTERN.test(destinationId)) {
    throw new BadRequestException('Destination ID is invalid');
  }
}

function commandRequestHash(action: string, input: ParsedCommandInput) {
  return createHash('sha256')
    .update(
      canonicalJson({
        action,
        destinationIds: [...input.destinationIds].sort(),
        selectionVersion: input.selectionVersion,
      }),
    )
    .digest('hex');
}

function selectionPayload(command: StoredCommand): DestinationSelectionPayload {
  if (!command.selection) {
    throw new Error('Destination command has no immutable selection');
  }
  return {
    version: command.selection.version,
    destinations: command.selection.destinations
      .sort((left, right) => left.position - right.position)
      .map((destination) => ({
        id: destination.destinationId,
        secretId: destination.secretId,
        versionId: destination.secretVersionId,
      })),
  };
}

function assertSelectionAcknowledged(
  acknowledgement: {
    version: string;
    selectionHash: string;
    count: number;
    destinationIds: string[];
  } | null,
  selection: DestinationSelectionPayload,
) {
  const expectedHash = createHash('sha256')
    .update(canonicalJson(selection))
    .digest('hex');
  const expectedIds = selection.destinations.map(
    (destination) => destination.id,
  );
  if (
    !acknowledgement ||
    acknowledgement.version !== selection.version ||
    acknowledgement.selectionHash !== expectedHash ||
    acknowledgement.count !== expectedIds.length ||
    acknowledgement.destinationIds.join('\n') !== expectedIds.join('\n')
  ) {
    throw new AlanaRequestError(502, {
      requestedState: 'unknown',
      actualState: 'degraded',
      transition: null,
      readiness: false,
      lastSequence: 0,
      activeDestinations: null,
      pendingDestinations: acknowledgement,
      destinations: [],
      commandResult: null,
      error: 'Alana did not acknowledge the exact destination selection',
    });
  }
}

function sameSet(left: string[], right: string[]) {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}
