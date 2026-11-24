# Operator change records

`OperatorChangeRecord` stores who changed something that shows on air (gaulatti/alcantara#236): the actor principal,
`via` (`mcp` or `console`), the MCP client name (null for the console), the capability, the program, and a `summary`
of what changed. The capabilities that write it and their summaries are listed in `docs/mcp-capabilities.md`
("Operator change records").

## Records with no program

`programId` is nullable (`20261124010000_operator_change_library`). A record is tied to a program only when the change
was made in one, such as radio settings, a flight sequence or a program rename. A change to something that belongs to
no single program is stored with `programId` NULL. That covers a scene, a layout, and the library: instants, stingers,
songs, media, media labels and media groups. One write stores one record; what changed is named in `summary.target`
(`{ kind, id }`). `teamId` stays NULL, as for every record so far.

The migration is additive: existing records keep their program, and the `(programId, createdAt)` index is unchanged.

## Reading the table

- **One program's changes:** `WHERE "programId" = '<id>'`. This excludes the records with no program, because NULL
  never equals a value.
- **Changes with no program:** `WHERE "programId" IS NULL`.
- **Every change, with the no-program rows labelled "Library":**

  ```sql
  SELECT COALESCE("programId", 'Library') AS "program", "capability", "principal", "via", "client", "createdAt"
  FROM "OperatorChangeRecord"
  ORDER BY "createdAt" DESC;
  ```

## Who reads it

Audited when `programId` became nullable: in the backend, the frontend, the MCP capabilities, the as-run joins and the
exports, nothing reads `OperatorChangeRecord`. The only code that touches it writes records (the radio settings write
and the operator change recorders), and the tenancy map classifies it as `tenant`. Operators read it with the queries
above. A reader added later must handle NULL as described here: a program filter leaves out the no-program rows, and a
list shows them as "Library".
