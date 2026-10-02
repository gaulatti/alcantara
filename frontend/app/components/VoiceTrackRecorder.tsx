import { Button, Input } from '@gaulatti/bleecker';
import { Mic, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';

interface VoiceTrackRecorderProps {
  songTitle: string;
  songUrl: string;
  onAttach: (
    instantId: number,
    mix: { duckGain: number; fadeInSeconds: number; fadeOutSeconds: number },
  ) => Promise<void>;
  onClose: () => void;
}

export function VoiceTrackRecorder({
  songTitle,
  songUrl,
  onAttach,
  onClose,
}: VoiceTrackRecorderProps) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const previewSong = useRef<HTMLAudioElement | null>(null);
  const previewVoice = useRef<HTMLAudioElement | null>(null);
  const [recording, setRecording] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duckGain, setDuckGain] = useState(0.35);
  const [fadeInSeconds, setFadeInSeconds] = useState(0.25);
  const [fadeOutSeconds, setFadeOutSeconds] = useState(0.25);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      previewSong.current?.pause();
      previewVoice.current?.pause();
    },
    [],
  );
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const start = async () => {
    setError(null);
    try {
      const mimeType = ['audio/webm', 'audio/mp4'].find((value) =>
        MediaRecorder.isTypeSupported(value),
      );
      if (!mimeType)
        throw new Error('This browser cannot record a supported audio format.');
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const chunks: BlobPart[] = [];
      const nextRecorder = new MediaRecorder(microphone, { mimeType });
      nextRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      nextRecorder.onstop = () => {
        const extension = mimeType === 'audio/mp4' ? 'm4a' : 'webm';
        const nextFile = new File(
          chunks,
          `voice-track-${Date.now()}.${extension}`,
          { type: mimeType },
        );
        if (nextFile.size > 0) {
          setFile(nextFile);
          setPreviewUrl(URL.createObjectURL(nextFile));
        } else setError('The recording was empty. Please record again.');
        microphone.getTracks().forEach((track) => track.stop());
        stream.current = null;
      };
      stream.current = microphone;
      recorder.current = nextRecorder;
      nextRecorder.start();
      setRecording(true);
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      setError(
        cause instanceof Error ? cause.message : 'Microphone access failed.',
      );
    }
  };

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    setRecording(false);
  };

  const previewSegue = async () => {
    if (!previewUrl) return;
    previewSong.current?.pause();
    previewVoice.current?.pause();
    const song = new Audio(songUrl);
    const voice = new Audio(previewUrl);
    song.volume = duckGain;
    previewSong.current = song;
    previewVoice.current = voice;
    try {
      await Promise.all([song.play(), voice.play()]);
    } catch {
      setError(
        'Segue preview could not play. Check browser audio permissions.',
      );
    }
  };

  const attach = async () => {
    if (!file) return;
    setSaving(true);
    setError(null);
    let instantId: number | null = null;
    try {
      const upload = await uploadFileToMediaBucket('instant', file);
      const response = await fetch(apiUrl('/instants'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Voice link: ${songTitle}`,
          audioUrl: upload.url,
          volume: 1,
          enabled: true,
        }),
      });
      if (!response.ok)
        throw new Error(`Audio clip creation failed (${response.status})`);
      const instant = (await response.json()) as { id: number };
      instantId = instant.id;
      await onAttach(instant.id, { duckGain, fadeInSeconds, fadeOutSeconds });
      onClose();
    } catch (cause) {
      if (instantId !== null) {
        await fetch(apiUrl(`/instants/${instantId}`), {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'Voice track could not be attached.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Record the link that will overlap the opening of{' '}
        <strong className="text-text-primary">{songTitle}</strong>.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void start()}
          disabled={recording || saving}
        >
          <Mic size={16} /> Record
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={stop}
          disabled={!recording}
        >
          <Square size={16} /> Stop
        </Button>
        {recording ? (
          <span
            role="status"
            className="self-center text-sm font-bold text-red-400"
          >
            RECORDING
          </span>
        ) : null}
      </div>
      {previewUrl ? (
        <div className="rounded-xl border border-border-subtle p-3">
          <span className="text-xs font-bold uppercase tracking-wide text-text-secondary">
            Recorded take
          </span>
          <audio
            className="mt-2 w-full"
            src={previewUrl}
            controls
            aria-label="Recorded voice track"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void previewSegue()}
          >
            <Volume2 size={16} /> Preview over song
          </Button>
          <p className="mt-1 text-xs text-text-secondary">
            Browser preview approximates the mix. Palazzo applies the saved duck
            and fades on air.
          </p>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-text-secondary">
          Song under voice (0–1)
          <Input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={duckGain}
            onChange={(event) => setDuckGain(Number(event.target.value))}
          />
        </label>
        <label className="text-xs text-text-secondary">
          Fade in (seconds)
          <Input
            type="number"
            min="0"
            max="5"
            step="0.05"
            value={fadeInSeconds}
            onChange={(event) => setFadeInSeconds(Number(event.target.value))}
          />
        </label>
        <label className="text-xs text-text-secondary">
          Fade out (seconds)
          <Input
            type="number"
            min="0"
            max="5"
            step="0.05"
            value={fadeOutSeconds}
            onChange={(event) => setFadeOutSeconds(Number(event.target.value))}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void attach()}
          disabled={
            !file ||
            saving ||
            recording ||
            ![duckGain, fadeInSeconds, fadeOutSeconds].every(Number.isFinite) ||
            duckGain < 0 ||
            duckGain > 1 ||
            fadeInSeconds < 0 ||
            fadeInSeconds > 5 ||
            fadeOutSeconds < 0 ||
            fadeOutSeconds > 5
          }
        >
          {saving ? 'Saving link…' : 'Use this take'}
        </Button>
      </div>
    </div>
  );
}
