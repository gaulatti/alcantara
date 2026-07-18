import React, { useEffect, useMemo, useState } from 'react';
import { fetchSongCatalog } from '../services/songs';
import type { SongCatalogItem } from '../models/broadcast';
import {
  normalizeModoItalianoBracketDrawCommand,
  normalizeModoItalianoBracketMatches,
  normalizeModoItalianoBracketStartRound,
  type ModoItalianoBracketDrawCommand,
  type ModoItalianoBracketMatch,
  type ModoItalianoBracketStartRound
} from '../utils/modoItalianoBracket';
import './ModoItalianoBracket.css';

const MODO_ITALIANO_DISPLAY_FONT = "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif";
const MODO_ITALIANO_LABEL_FONT = "'Outfit', 'Encode Sans', system-ui, sans-serif";
const FINAL_PANEL_HEIGHT_PX = 224;

export interface ModoItalianoBracketProps {
  title?: string;
  show?: boolean;
  startRound?: ModoItalianoBracketStartRound;
  matches?: ModoItalianoBracketMatch[];
  drawCommand?: ModoItalianoBracketDrawCommand;
  voters?: Array<{ id: string; name: string }>;
  matchVotes?: Record<string, Record<string, number | null>>;
  activeVotingMatchId?: number | null;
  votingWinnerId?: number | null;
  votingResultStartedAt?: number | null;
}

export const ModoItalianoBracket: React.FC<ModoItalianoBracketProps> = ({
  title = 'TORNEO CANCIÓN',
  show = true,
  startRound = 'roundOf16',
  matches = [],
  drawCommand = undefined,
  voters = [],
  matchVotes = {},
  activeVotingMatchId = null,
  votingWinnerId = null,
  votingResultStartedAt = null
}) => {
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [drawStartedAtMs, setDrawStartedAtMs] = useState(0);
  const [votingNowMs, setVotingNowMs] = useState(() => Date.now());

  useEffect(() => {
    fetchSongCatalog()
      .then(setSongs)
      .catch((err) => console.error('Failed to fetch songs for bracket:', err));
  }, []);

  const normalizedDrawCommand = normalizeModoItalianoBracketDrawCommand(drawCommand);
  const drawEndsAtMs = normalizedDrawCommand && drawStartedAtMs > 0 ? drawStartedAtMs + normalizedDrawCommand.durationSeconds * 1000 : 0;
  const isDrawing = Boolean(normalizedDrawCommand && drawStartedAtMs > 0 && nowMs < drawEndsAtMs);

  useEffect(() => {
    setDrawStartedAtMs(normalizedDrawCommand ? Date.now() : 0);
  }, [normalizedDrawCommand?.id]);

  useEffect(() => {
    if (!normalizedDrawCommand || Date.now() >= drawEndsAtMs) {
      return;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [drawEndsAtMs, normalizedDrawCommand?.id]);

  useEffect(() => {
    if (typeof votingResultStartedAt !== 'number' || votingResultStartedAt <= 0) return;
    setVotingNowMs(Date.now());
    const timer = window.setInterval(() => setVotingNowMs(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [votingResultStartedAt]);

  const normalizedStartRound = normalizeModoItalianoBracketStartRound(startRound);
  const isQuarterfinalStart = normalizedStartRound === 'quarterfinals';
  const safeMatches = useMemo(() => normalizeModoItalianoBracketMatches(matches, normalizedStartRound), [matches, normalizedStartRound]);

  if (!show) {
    return null;
  }

  const getSong = (id: number | null) => songs.find((s) => s.id === id);

  const renderSong = (song: SongCatalogItem | undefined, isRightWing: boolean) => {
    if (!song) {
      return (
        <span
          className={`text-[#f3f3f3] text-[20px] font-bold uppercase truncate flex-1 leading-none tracking-wide text-shadow-sm px-2 ${isRightWing ? 'text-right' : 'text-left'}`}
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
          <span
            className='text-[#aaaaaa] text-[20px] font-bold uppercase truncate leading-none tracking-wide'
            style={{ fontFamily: MODO_ITALIANO_DISPLAY_FONT }}
          >
            {song.artist}
          </span>
          <span
            className='text-[#f3f3f3] text-[26px] font-bold uppercase truncate leading-none tracking-wide text-shadow-sm'
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
  const drawnSongs = normalizedDrawCommand ? normalizedDrawCommand.songIds.map((songId) => getSong(songId)).filter((song): song is SongCatalogItem => Boolean(song)) : [];
  const drawProgress = normalizedDrawCommand && drawStartedAtMs > 0 ? Math.min(1, Math.max(0, (nowMs - drawStartedAtMs) / (normalizedDrawCommand.durationSeconds * 1000))) : 0;
  const featuredDrawSong = drawnSongs.length > 0 ? drawnSongs[Math.floor(nowMs / 180) % drawnSongs.length] : null;
  const activeVotingMatch = typeof activeVotingMatchId === 'number' ? safeMatches[activeVotingMatchId - 1] : null;
  const activeVoters = voters.filter((voter) => voter && typeof voter.id === 'string' && typeof voter.name === 'string' && voter.name.trim());
  const voterRotationOffset = activeVotingMatch && activeVoters.length > 0 ? (activeVotingMatch.id - (isQuarterfinalStart ? 9 : 1)) % activeVoters.length : 0;
  const rotatedActiveVoters = voterRotationOffset > 0 ? [...activeVoters.slice(voterRotationOffset), ...activeVoters.slice(0, voterRotationOffset)] : activeVoters;
  const votingResultVisible =
    activeVotingMatch !== null &&
    activeVotingMatch.winnerId !== null &&
    activeVotingMatch.winnerId === votingWinnerId &&
    typeof votingResultStartedAt === 'number' &&
    votingNowMs < votingResultStartedAt + 10_000;
  const votingWinner = votingResultVisible ? getSong(votingWinnerId) : undefined;

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
      {isDrawing && (
        <div className='modoitaliano-bracket-draw-panel'>
          <div className='modoitaliano-bracket-draw-label' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>
            SORTEO
          </div>
          <div className='modoitaliano-bracket-draw-card'>
            {featuredDrawSong?.coverUrl && <img src={featuredDrawSong.coverUrl} className='modoitaliano-bracket-draw-cover' />}
            <div className='modoitaliano-bracket-draw-copy'>
              <span className='modoitaliano-bracket-draw-artist'>{featuredDrawSong?.artist ?? 'Seleccionando'}</span>
              <span className='modoitaliano-bracket-draw-title'>{featuredDrawSong?.title ?? 'Canciones'}</span>
            </div>
          </div>
          <div className='modoitaliano-bracket-draw-track'>
            <div className='modoitaliano-bracket-draw-progress' style={{ width: `${drawProgress * 100}%` }} />
          </div>
        </div>
      )}

      {activeVotingMatch && activeVotingMatch.songAId !== null && activeVotingMatch.songBId !== null && rotatedActiveVoters.length > 0 && (activeVotingMatch.winnerId === null || votingResultVisible) && (
        <div key={`voting-${activeVotingMatch.id}-${votingResultVisible ? votingResultStartedAt : 'open'}`} className='modoitaliano-bracket-voting-modal'>
          {votingResultVisible ? (
            <div className='modoitaliano-bracket-voting-winner modoitaliano-bracket-voting-winner-reveal' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>
              <span>WINNER</span>
              {votingWinner?.coverUrl && <img src={votingWinner.coverUrl} alt='' />}
              <strong>{votingWinner ? `${votingWinner.artist} - ${votingWinner.title}` : 'Winner'}</strong>
            </div>
          ) : (
            <>
              <div className='modoitaliano-bracket-voting-title' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>VOTACIÓN</div>
              <div className='modoitaliano-bracket-voting-grid' style={{ gridTemplateColumns: `repeat(${rotatedActiveVoters.length}, minmax(0, 1fr))` }}>
                {rotatedActiveVoters.map((voter) => {
                  const vote = matchVotes[String(activeVotingMatch.id)]?.[voter.id] ?? null;
                  const votedSong = getSong(vote);
                  return (
                    <div key={voter.id} className='modoitaliano-bracket-voting-voter'>
                      <div key={`${voter.id}-${vote ?? 'empty'}`} className={`modoitaliano-bracket-voting-cover ${votedSong ? 'modoitaliano-bracket-voting-cover-reveal' : ''}`}>
                        {votedSong?.coverUrl && <img src={votedSong.coverUrl} alt='' />}
                      </div>
                      <div className='modoitaliano-bracket-voting-name' style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}>{voter.name}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Bracket Container */}
      <div className='modoitaliano-bracket-stage flex w-full px-8 flex-1 pb-16 justify-between items-stretch relative'>
        {/* Left Side */}
        <div className='flex justify-start relative z-10 w-1/2'>
          {!isQuarterfinalStart && <RoundColumn matches={[1, 2, 3, 4]} round={1} isLeft={true} className='z-10' />}
          <RoundColumn matches={[9, 10]} round={2} isLeft={true} className={`z-20 ${isQuarterfinalStart ? '' : 'ml-[30px]'}`} />
          <RoundColumn matches={[13]} round={3} isLeft={true} className={`z-30 ${isQuarterfinalStart ? 'ml-[30px]' : '-ml-[370px]'}`} />
        </div>

        {/* Right Side */}
        <div className='flex justify-end relative z-10 w-1/2'>
          <RoundColumn matches={[14]} round={3} isLeft={false} className={`z-30 ${isQuarterfinalStart ? 'mr-[30px]' : '-mr-[370px]'}`} />
          <RoundColumn matches={[11, 12]} round={2} isLeft={false} className={`z-20 ${isQuarterfinalStart ? '' : 'mr-[30px]'}`} />
          {!isQuarterfinalStart && <RoundColumn matches={[5, 6, 7, 8]} round={1} isLeft={false} className='z-10' />}
        </div>

        {/* Center / Final */}
        <div className='absolute top-[100%] left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center justify-center gap-12 z-20 pointer-events-none w-full max-w-[900px]'>
          <div
            className='flex flex-col items-center bg-[#1D1D1B] p-3 rounded-md shadow-2xl border border-[#3A3A3A]'
            style={{ height: `${FINAL_PANEL_HEIGHT_PX}px` }}
          >
            <span
              className='text-white opacity-80 text-xl font-bold tracking-widest mb-3 uppercase leading-none'
              style={{ fontFamily: MODO_ITALIANO_LABEL_FONT }}
            >
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
              {champion.coverUrl && (
                <img src={champion.coverUrl} className='h-0 min-h-0 flex-1 aspect-square object-cover rounded-md shadow-2xl border-2 border-[#e2a842]' />
              )}
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
