import React, { useEffect, useState } from 'react';
import { fetchSongCatalog } from '../services/songs';
import type { SongCatalogItem } from '../models/broadcast';
import { normalizeModoItalianoBracketMatches, type ModoItalianoBracketMatch } from '../utils/modoItalianoBracket';
import './ModoItalianoBracket.css';

const MODO_ITALIANO_DISPLAY_FONT = "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif";
const MODO_ITALIANO_LABEL_FONT = "'Outfit', 'Encode Sans', system-ui, sans-serif";
const FINAL_PANEL_HEIGHT_PX = 224;

export interface ModoItalianoBracketProps {
  title?: string;
  show?: boolean;
  matches?: ModoItalianoBracketMatch[];
}

export const ModoItalianoBracket: React.FC<ModoItalianoBracketProps> = ({ title = 'TORNEO CANCIÓN', show = true, matches = [] }) => {
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);

  useEffect(() => {
    fetchSongCatalog()
      .then(setSongs)
      .catch((err) => console.error('Failed to fetch songs for bracket:', err));
  }, []);

  if (!show) {
    return null;
  }

  const safeMatches = normalizeModoItalianoBracketMatches(matches);

  const getSong = (id: number | null) => songs.find((s) => s.id === id);

  const renderSong = (song: SongCatalogItem | undefined, isRightWing: boolean) => {
    if (!song) {
      return (
        <span
          className={`text-[#f3f3f3] text-[24px] font-bold uppercase truncate flex-1 leading-none tracking-wide text-shadow-sm px-2 ${isRightWing ? 'text-right' : 'text-left'}`}
          style={{ fontFamily: MODO_ITALIANO_DISPLAY_FONT }}
        >
          TBD
        </span>
      );
    }
    return (
      <div className={`flex items-center flex-1 min-w-0 h-full ${isRightWing ? 'flex-row-reverse' : ''}`}>
        {song.coverUrl && <img src={song.coverUrl} className='w-[110px] h-full object-cover flex-shrink-0' />}
        <div className={`flex flex-col min-w-0 flex-1 justify-center gap-[4px] px-4 ${isRightWing ? 'text-right items-end' : 'text-left items-start'}`}>
          <span className='text-[#aaaaaa] text-[22px] font-bold uppercase truncate leading-none tracking-wide' style={{ fontFamily: MODO_ITALIANO_DISPLAY_FONT }}>
            {song.artist}
          </span>
          <span
            className='text-[#f3f3f3] text-[30px] font-bold uppercase truncate leading-none tracking-wide text-shadow-sm'
            style={{ fontFamily: MODO_ITALIANO_DISPLAY_FONT }}
          >
            {song.title}
          </span>
        </div>
      </div>
    );
  };

  const MatchNode = ({ matchId, round, isLeft }: { matchId: number; round: number; isLeft: boolean }) => {
    const match = safeMatches[matchId - 1];
    const songA = getSong(match.songAId);
    const songB = getSong(match.songBId);

    const isAWinner = match.winnerId === match.songAId && match.songAId !== null;
    const isBWinner = match.winnerId === match.songBId && match.songBId !== null;

    return (
      <div
        className='flex flex-col relative justify-center bg-[#2B2B2B] shadow-lg rounded-sm overflow-hidden'
        style={{
          width: '420px',
          height: '160px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.45)',
          fontFamily: MODO_ITALIANO_DISPLAY_FONT
        }}
      >
        <div
          className={`flex items-center h-1/2 border-b border-[#3A3A3A] relative ${!isLeft ? 'flex-row-reverse' : ''}`}
          style={{ opacity: match.winnerId && !isAWinner ? 0.4 : 1 }}
        >
          {isAWinner && <div className={`absolute top-0 bottom-0 w-2 bg-red-600 ${!isLeft ? 'right-0' : 'left-0'}`} />}
          {renderSong(songA, !isLeft)}
        </div>
        <div className={`flex items-center h-1/2 relative ${!isLeft ? 'flex-row-reverse' : ''}`} style={{ opacity: match.winnerId && !isBWinner ? 0.4 : 1 }}>
          {isBWinner && <div className={`absolute top-0 bottom-0 w-2 bg-red-600 ${!isLeft ? 'right-0' : 'left-0'}`} />}
          {renderSong(songB, !isLeft)}
        </div>
      </div>
    );
  };

  const RoundColumn = ({ matches, round, isLeft, className = '' }: { matches: number[]; round: number; isLeft: boolean; className?: string }) => {
    return (
      <div className={`flex flex-col justify-around h-full py-4 ${isLeft ? 'items-end' : 'items-start'} flex-shrink-0 ${className}`}>
        {matches.map((mId) => (
          <MatchNode key={mId} matchId={mId} round={round} isLeft={isLeft} />
        ))}
      </div>
    );
  };

  // The Final Match (Centered)
  const finalMatch = safeMatches[14];
  const finalSongA = getSong(finalMatch.songAId);
  const finalSongB = getSong(finalMatch.songBId);
  const isAFinalWinner = finalMatch.winnerId === finalMatch.songAId && finalMatch.songAId !== null;
  const isBFinalWinner = finalMatch.winnerId === finalMatch.songBId && finalMatch.songBId !== null;
  const champion = getSong(finalMatch.winnerId);

  return (
    <div
      className='modoitaliano-bracket-root absolute inset-0 z-[900]'
      style={{
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '40px',
        paddingBottom: '200px',
        fontFamily: MODO_ITALIANO_DISPLAY_FONT
      }}
    >
      {/* Bracket Container */}
      <div className='modoitaliano-bracket-stage flex w-full px-8 flex-1 pb-16 justify-between items-stretch relative'>
        {/* Left Side */}
        <div className='flex justify-start relative z-10 w-1/2'>
          <RoundColumn matches={[1, 2, 3, 4]} round={1} isLeft={true} className='z-10' />
          <RoundColumn matches={[9, 10]} round={2} isLeft={true} className='z-20 ml-[30px]' />
          <RoundColumn matches={[13]} round={3} isLeft={true} className='z-30 -ml-[370px]' />
        </div>

        {/* Right Side */}
        <div className='flex justify-end relative z-10 w-1/2'>
          <RoundColumn matches={[14]} round={3} isLeft={false} className='z-30 -mr-[370px]' />
          <RoundColumn matches={[11, 12]} round={2} isLeft={false} className='z-20 mr-[30px]' />
          <RoundColumn matches={[5, 6, 7, 8]} round={1} isLeft={false} className='z-10' />
        </div>

        {/* Center / Final */}
        <div className='absolute top-[100%] left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center justify-center gap-12 z-20 pointer-events-none w-full max-w-[900px]'>
          <div className='flex flex-col items-center bg-[#1D1D1B] p-3 rounded-md shadow-2xl border border-[#3A3A3A]' style={{ height: `${FINAL_PANEL_HEIGHT_PX}px` }}>
            <span className='text-white opacity-80 text-xl font-bold tracking-widest mb-3 uppercase leading-none' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>
              Gran Final
            </span>
            <div
              className='flex flex-1 flex-col relative justify-center bg-[#1D1D1B] shadow-inner rounded-sm overflow-hidden'
              style={{
                width: '420px',
                border: '1px solid #2B2B2B',
                fontFamily: MODO_ITALIANO_DISPLAY_FONT
              }}
            >
              <div className='flex items-center h-1/2 border-b border-[#2B2B2B] relative' style={{ opacity: finalMatch.winnerId && !isAFinalWinner ? 0.3 : 1 }}>
                {isAFinalWinner && <div className='absolute left-0 top-0 bottom-0 w-3 bg-[#e2a842]' />}
                {renderSong(finalSongA, false)}
              </div>
              <div className='flex items-center h-1/2 relative' style={{ opacity: finalMatch.winnerId && !isBFinalWinner ? 0.3 : 1 }}>
                {isBFinalWinner && <div className='absolute left-0 top-0 bottom-0 w-3 bg-[#e2a842]' />}
                {renderSong(finalSongB, false)}
              </div>
            </div>
          </div>

          {champion ? (
            <div className='flex flex-col items-center' style={{ height: `${FINAL_PANEL_HEIGHT_PX}px` }}>
              <span className='text-[#e2a842] text-xl font-black tracking-widest mb-3 shadow-sm leading-none' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>
                CAMPEÓN
              </span>
              {champion.coverUrl && <img src={champion.coverUrl} className='h-0 min-h-0 flex-1 aspect-square object-cover rounded-md shadow-2xl border-2 border-[#e2a842]' />}
            </div>
          ) : (
            <div className='flex flex-col items-center opacity-30' style={{ height: `${FINAL_PANEL_HEIGHT_PX}px` }}>
              <span className='text-white text-xl font-black tracking-widest mb-3 leading-none' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>
                CAMPEÓN
              </span>
              <div className='h-0 min-h-0 flex-1 aspect-square border-2 border-dashed border-white rounded-md' />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
