import { AlertContainer, Button, Card, Checkbox, Empty, Field, Input, LoadingSpinner, SectionHeader, Select, showAlert } from '@gaulatti/bleecker';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppPage } from '../components/AppPage';
import { apiUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import type { Route } from './+types/radio-settings';

interface RadioSettings {
  palazzoUrl: string;
  bumperEnabled: boolean;
  bumperInterval: number | null;
  bumperInstantIds: number[];
  bumperMode: string | null;
  enabled: boolean;
}

interface InstantOption {
  id: number;
  name: string;
  enabled: boolean;
}

interface HeaderDraft {
  id: string;
  name: string;
  value: string;
}

interface ConsumerDraft {
  id?: number;
  name: string;
  url: string;
  method: string;
  headers: HeaderDraft[];
  enabled: boolean;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Radio distribution - Alcántara' },
    {
      name: 'description',
      content: 'Configure radio automation and now-playing delivery'
    }
  ];
}

function draftId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeConsumer(value: any): ConsumerDraft {
  const headers = value?.headers && typeof value.headers === 'object' && !Array.isArray(value.headers) ? (value.headers as Record<string, string>) : {};
  return {
    id: typeof value?.id === 'number' ? value.id : undefined,
    name: typeof value?.name === 'string' ? value.name : '',
    url: typeof value?.url === 'string' ? value.url : '',
    method: typeof value?.method === 'string' ? value.method : 'POST',
    headers: Object.entries(headers).map(([name, value]) => ({
      id: draftId(),
      name,
      value: String(value)
    })),
    enabled: value?.enabled !== false
  };
}

export default function RadioSettingsRoute() {
  const [programId] = useGlobalProgramId();
  const [settings, setSettings] = useState<RadioSettings | null>(null);
  const [consumers, setConsumers] = useState<ConsumerDraft[]>([]);
  const [instants, setInstants] = useState<InstantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingConsumers, setSavingConsumers] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, consumersResponse, instantsResponse] = await Promise.all([
        fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/settings`)),
        fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/now-playing-consumers`)),
        fetch(apiUrl('/instants'))
      ]);
      if (!settingsResponse.ok) throw new Error(`Radio settings failed (${settingsResponse.status})`);
      if (!consumersResponse.ok) throw new Error(`Now-playing delivery failed (${consumersResponse.status})`);
      if (!instantsResponse.ok) throw new Error(`Audio clips failed (${instantsResponse.status})`);
      setSettings((await settingsResponse.json()) as RadioSettings);
      const consumerPayload = await consumersResponse.json();
      setConsumers(Array.isArray(consumerPayload) ? consumerPayload.map(normalizeConsumer) : []);
      const instantPayload = await instantsResponse.json();
      setInstants(Array.isArray(instantPayload) ? instantPayload : []);
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Radio configuration could not be loaded.', 'error');
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const response = await fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/settings`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (!response.ok) throw new Error(`Radio settings were not saved (${response.status})`);
      setSettings((await response.json()) as RadioSettings);
      showAlert('Radio distribution settings saved.', 'success');
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Radio settings were not saved.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const saveConsumers = async () => {
    setSavingConsumers(true);
    try {
      const payload = consumers.map((consumer, index) => {
        const headers = Object.fromEntries(consumer.headers.filter((header) => header.name.trim() && header.value.trim()).map((header) => [header.name.trim(), header.value.trim()]));
        if (consumer.headers.some((header) => !header.name.trim() && header.value.trim())) {
          throw new Error(`Consumer ${index + 1}: header name is required`);
        }
        return {
          name: consumer.name.trim(),
          url: consumer.url.trim(),
          method: consumer.method,
          headers,
          enabled: consumer.enabled
        };
      });
      const response = await fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/now-playing-consumers`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumers: payload })
      });
      if (!response.ok) throw new Error(`Now-playing delivery was not saved (${response.status})`);
      const result = await response.json();
      setConsumers(Array.isArray(result) ? result.map(normalizeConsumer) : []);
      showAlert('Now-playing delivery saved.', 'success');
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Now-playing delivery was not saved.', 'error');
    } finally {
      setSavingConsumers(false);
    }
  };

  const updateConsumer = (index: number, patch: Partial<ConsumerDraft>) => {
    setConsumers((current) => current.map((consumer, position) => (position === index ? { ...consumer, ...patch } : consumer)));
  };

  return (
    <AppPage width='wide' className='space-y-6'>
      <AlertContainer />
      <SectionHeader title='Radio distribution' description={`Automation, Palazzo, and metadata delivery for ${programId}. Live playout remains in the Radio desk.`} />

      {loading ? (
        <div className='flex min-h-64 items-center justify-center'>
          <LoadingSpinner size='lg' />
        </div>
      ) : !settings ? (
        <Empty
          title='Radio configuration unavailable'
          description='The selected show does not expose a radio configuration. Select a Radio or Simulcast show and retry.'
          action={
            <Button variant='secondary' onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]'>
          <Card variant='outlined' padding='lg' className='space-y-5'>
            <div>
              <p className='text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary'>Automation</p>
              <h2 className='mt-1 text-xl font-semibold'>Radio playout</h2>
            </div>
            <Checkbox checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} label='Enable Alcántara radio automation' />
            <Field label='Palazzo control URL'>
              <Input value={settings.palazzoUrl} onChange={(event) => setSettings({ ...settings, palazzoUrl: event.target.value })} />
            </Field>
            <div className='rounded-[var(--radius-ui)] border border-sand/25 p-4 dark:border-white/10'>
              <Checkbox
                checked={settings.bumperEnabled}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    bumperEnabled: event.target.checked
                  })
                }
                label='Insert station IDs and bumpers'
              />
              {settings.bumperEnabled ? (
                <div className='mt-4 grid gap-4 sm:grid-cols-2'>
                  <Field label='Bumper order'>
                    <Select
                      value={settings.bumperMode || 'sequential'}
                      onChange={(value) => setSettings({ ...settings, bumperMode: value })}
                      options={[
                        { value: 'sequential', label: 'Sequential' },
                        { value: 'random', label: 'Random' }
                      ]}
                    />
                  </Field>
                  <Field label='Insert every N songs'>
                    <Input
                      type='number'
                      min={1}
                      value={settings.bumperInterval ?? 4}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          bumperInterval: Number(event.target.value) || null
                        })
                      }
                    />
                  </Field>
                  <div className='space-y-2 sm:col-span-2'>
                    <p className='text-sm font-medium'>Eligible audio clips</p>
                    <div className='grid gap-2 sm:grid-cols-2'>
                      {instants
                        .filter((instant) => instant.enabled)
                        .map((instant) => (
                          <Checkbox
                            key={instant.id}
                            checked={settings.bumperInstantIds.includes(instant.id)}
                            onChange={() =>
                              setSettings({
                                ...settings,
                                bumperInstantIds: settings.bumperInstantIds.includes(instant.id)
                                  ? settings.bumperInstantIds.filter((id) => id !== instant.id)
                                  : [...settings.bumperInstantIds, instant.id]
                              })
                            }
                            label={instant.name}
                          />
                        ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className='flex justify-end'>
              <Button loading={savingSettings} onClick={() => void saveSettings()}>
                <Save size={15} /> Save radio settings
              </Button>
            </div>
          </Card>

          <Card variant='outlined' padding='lg' className='space-y-5'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <p className='text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary'>Distribution</p>
                <h2 className='mt-1 text-xl font-semibold'>Now-playing consumers</h2>
                <p className='mt-1 text-sm text-text-secondary'>Send bounded track metadata to configured downstream services.</p>
              </div>
              <Button
                size='sm'
                variant='secondary'
                onClick={() =>
                  setConsumers((current) => [
                    ...current,
                    {
                      name: `consumer-${current.length + 1}`,
                      url: '',
                      method: 'POST',
                      headers: [],
                      enabled: true
                    }
                  ])
                }
              >
                <Plus size={14} /> Add consumer
              </Button>
            </div>
            {consumers.length === 0 ? (
              <Empty title='No consumers configured' description='Add a destination when another service needs now-playing metadata.' />
            ) : (
              <div className='space-y-4'>
                {consumers.map((consumer, index) => (
                  <section key={consumer.id ?? index} className='space-y-4 rounded-[var(--radius-ui)] border border-sand/25 p-4 dark:border-white/10'>
                    <div className='flex items-center justify-between gap-3'>
                      <Checkbox
                        checked={consumer.enabled}
                        onChange={(event) =>
                          updateConsumer(index, {
                            enabled: event.target.checked
                          })
                        }
                        label='Enabled'
                      />
                      <Button
                        size='sm'
                        variant='ghost'
                        aria-label={`Remove ${consumer.name || `consumer ${index + 1}`}`}
                        onClick={() => setConsumers((current) => current.filter((_, position) => position !== index))}
                      >
                        <Trash2 size={14} /> Remove
                      </Button>
                    </div>
                    <div className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]'>
                      <Field label='Name'>
                        <Input value={consumer.name} onChange={(event) => updateConsumer(index, { name: event.target.value })} />
                      </Field>
                      <Field label='Method'>
                        <Select
                          value={consumer.method}
                          onChange={(value) => updateConsumer(index, { method: value })}
                          options={['POST', 'PUT', 'PATCH'].map((value) => ({
                            value,
                            label: value
                          }))}
                        />
                      </Field>
                    </div>
                    <Field label='URL'>
                      <Input type='url' value={consumer.url} onChange={(event) => updateConsumer(index, { url: event.target.value })} />
                    </Field>
                    <div className='space-y-2'>
                      <div className='flex items-center justify-between gap-3'>
                        <p className='text-sm font-medium'>Request headers</p>
                        <Button
                          size='xs'
                          variant='ghost'
                          onClick={() =>
                            updateConsumer(index, {
                              headers: [...consumer.headers, { id: draftId(), name: '', value: '' }]
                            })
                          }
                        >
                          <Plus size={13} /> Add header
                        </Button>
                      </div>
                      {consumer.headers.map((header) => (
                        <div key={header.id} className='grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2'>
                          <Input
                            aria-label='Header name'
                            placeholder='Header'
                            value={header.name}
                            onChange={(event) =>
                              updateConsumer(index, {
                                headers: consumer.headers.map((item) => (item.id === header.id ? { ...item, name: event.target.value } : item))
                              })
                            }
                          />
                          <Input
                            aria-label='Header value'
                            type='password'
                            placeholder='Value'
                            value={header.value}
                            onChange={(event) =>
                              updateConsumer(index, {
                                headers: consumer.headers.map((item) => (item.id === header.id ? { ...item, value: event.target.value } : item))
                              })
                            }
                          />
                          <Button
                            size='sm'
                            variant='ghost'
                            aria-label='Remove header'
                            onClick={() =>
                              updateConsumer(index, {
                                headers: consumer.headers.filter((item) => item.id !== header.id)
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            <div className='flex justify-end'>
              <Button loading={savingConsumers} onClick={() => void saveConsumers()}>
                <Save size={15} /> Save consumers
              </Button>
            </div>
          </Card>
        </div>
      )}
    </AppPage>
  );
}
