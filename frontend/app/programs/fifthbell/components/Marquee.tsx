import { BellRing } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from '../events';

interface MarqueeProps {
  events: Event[];
  onCycleComplete?: () => void;
}

function calculateMedianRelevance(posts: { relevance: number }[]): number {
  if (posts.length === 0) return 0;
  const scores = posts.map((post) => post.relevance).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  return scores.length % 2 === 0 ? (scores[mid - 1] + scores[mid]) / 2 : scores[mid];
}

function calculateAverageRelevance(posts: { relevance: number }[]): number {
  if (posts.length === 0) return 0;
  const sum = posts.reduce((acc, post) => acc + post.relevance, 0);
  return sum / posts.length;
}

export function Marquee({ events, onCycleComplete }: MarqueeProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [animationDuration, setAnimationDuration] = useState('20s');

  const sortedEvents = useMemo(() => {
    return events
      .filter((event) => {
        const postsCount = event.posts.length;
        const average = calculateAverageRelevance(event.posts);
        const median = calculateMedianRelevance(event.posts);
        return postsCount >= 4 || average >= 5 || median >= 7;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [events]);

  useEffect(() => {
    const updateDuration = () => {
      if (!contentRef.current) {
        return;
      }

      const contentWidth = contentRef.current.scrollWidth;
      const totalDistance = 1920 + contentWidth;
      const duration = Math.max(totalDistance / 150, 10);
      setAnimationDuration(`${duration}s`);
    };

    const timer = window.setTimeout(updateDuration, 100);
    window.addEventListener('resize', updateDuration);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', updateDuration);
    };
  }, [sortedEvents]);

  if (sortedEvents.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '50px',
        backgroundColor: '#000000',
        borderTop: '2px solid #b21100',
        overflow: 'hidden',
        zIndex: 100
      }}
    >
      <div
        ref={contentRef}
        onAnimationIteration={onCycleComplete}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          animation: `marqueeFlow ${animationDuration} linear infinite`,
          whiteSpace: 'nowrap',
          width: 'max-content'
        }}
      >
        {sortedEvents.map((event) => (
          <div key={event.uuid} style={{ display: 'flex', alignItems: 'center' }}>
            <span
              style={{
                color: '#ffffff',
                fontSize: '1.5rem',
                fontWeight: '600',
                fontFamily: 'Libre Franklin, sans-serif'
              }}
            >
              {event.title}
            </span>
            <div
              style={{
                marginLeft: '2rem',
                marginRight: '2rem',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <div
                style={{
                  backgroundColor: '#b21100',
                  padding: '0.5rem',
                  borderRadius: '0.25rem'
                }}
              >
                <BellRing size={24} strokeWidth={2} color='#ffffff' />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(Marquee);
