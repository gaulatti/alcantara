import { Button, CoverTile, Empty, ErrorState, Modal, SearchInput, Skeleton } from '@gaulatti/bleecker';
import { useEffect, useState } from 'react';
import { fetchMediaImages, type MediaImage } from '../services/mediaImages';

/** Only an https image can be a logo: the stored address is shown on air and must load over TLS. */
export function isHttpsImage(image: Pick<MediaImage, 'imageUrl'>): boolean {
  return image.imageUrl.startsWith('https://');
}

/**
 * Chooses a program logo from the media library (gaulatti/alcantara#408). It lists the library's
 * images, narrowed by name, and hands the chosen image's public address to `onPick`. An image whose
 * address is not https is shown but cannot be chosen.
 */
export function LogoPicker({
  isOpen,
  onClose,
  onPick,
}: {
  isOpen: boolean;
  onClose: () => void;
  onPick: (image: MediaImage) => void;
}) {
  const [term, setTerm] = useState('');
  const [images, setImages] = useState<MediaImage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setImages(null);
    setFailed(false);
    fetchMediaImages(term)
      .then((list) => {
        if (!cancelled) setImages(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, term, attempt]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title='Choose a logo from the media library'>
      <div className='space-y-4'>
        <SearchInput
          aria-label='Search the media library'
          placeholder='Search by name'
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onClear={() => setTerm('')}
        />
        {failed ? (
          <ErrorState
            title='The media library could not be loaded.'
            description='Nothing was changed.'
            retryLabel='Try again'
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : images === null ? (
          <div aria-busy='true' aria-label='Loading the media library' className='grid grid-cols-3 gap-3'>
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} height={96} />
            ))}
          </div>
        ) : images.length === 0 ? (
          <Empty
            title={term.trim() ? 'No image matches this search.' : 'The media library has no images yet.'}
            description='Images are added in the media library.'
          />
        ) : (
          <ul className='grid grid-cols-2 gap-3 sm:grid-cols-3' aria-label='Media library images'>
            {images.map((image) => {
              const usable = isHttpsImage(image);
              return (
                <li key={image.id}>
                  <Button
                    variant='ghost'
                    className='h-auto w-full flex-col items-stretch gap-2 p-2'
                    disabled={!usable}
                    aria-label={usable ? `Use ${image.name}` : `${image.name} (not an https address)`}
                    onClick={() => onPick(image)}
                  >
                    <CoverTile label={image.name} src={image.imageUrl} seed={String(image.id)} size='fill' ratio='16:9' />
                    <span className='truncate text-left text-sm'>{image.name}</span>
                    {usable ? null : <span className='text-left text-xs text-text-secondary'>Not an https address</span>}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
