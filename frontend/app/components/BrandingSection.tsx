import { Button, Card, Field, Input } from '@gaulatti/bleecker';
import { useEffect, useState } from 'react';
import { fetchProgramBranding, saveProgramBranding, type ProgramBrandingMarks } from '../services/program';

const FIELDS: { key: Exclude<keyof ProgramBrandingMarks, 'logoUrl'>; label: string }[] = [
  { key: 'displayName', label: 'Display name' },
  { key: 'callsign', label: 'Callsign' },
  { key: 'subtitle', label: 'Subtitle' },
  { key: 'hashtag', label: 'Hashtag' },
  { key: 'siteUrl', label: 'Site address' },
  { key: 'defaultChyron', label: 'Default chyron' },
];

const EMPTY: ProgramBrandingMarks = {
  displayName: null,
  callsign: null,
  subtitle: null,
  logoUrl: null,
  hashtag: null,
  siteUrl: null,
  defaultChyron: null,
};

/** A logo is an https address. Media-library assets are not yet offered as a picker (gaulatti/alcantara#335). */
export function logoError(value: string): string | null {
  if (!value) return null;
  return value.startsWith('https://') ? null : 'The logo must be an https address.';
}

export function BrandingSection({ programId }: { programId: string }) {
  const [marks, setMarks] = useState<ProgramBrandingMarks>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProgramBranding(programId)
      .then((stored) => {
        if (!cancelled) setMarks({ ...EMPTY, ...(stored ?? {}) });
      })
      .catch(() => {
        if (!cancelled) setError('The branding could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [programId]);

  const save = async () => {
    const problem = logoError(marks.logoUrl ?? '');
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const stored = await saveProgramBranding(programId, marks);
      setMarks({ ...EMPTY, ...stored });
    } catch {
      setError('The branding could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant='outlined' padding='lg' className='space-y-5'>
      <div>
        <h2 className='mt-1 text-xl font-semibold'>Branding</h2>
        <p className='text-sm text-text-secondary'>The station marks this program shows. A program with no branding shows none.</p>
      </div>
      {!loaded ? null : (
        <>
          {FIELDS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Input
                value={marks[key] ?? ''}
                onChange={(event) => setMarks({ ...marks, [key]: event.target.value || null })}
              />
            </Field>
          ))}
          <Field label='Logo address (https)'>
            <Input
              value={marks.logoUrl ?? ''}
              onChange={(event) => setMarks({ ...marks, logoUrl: event.target.value || null })}
            />
          </Field>
          {error ? <p role='alert' className='text-sm text-red-200'>{error}</p> : null}
          <Button onClick={save} disabled={saving}>
            Save branding
          </Button>
        </>
      )}
    </Card>
  );
}
