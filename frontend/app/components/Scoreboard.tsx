import React from 'react';
import './Scoreboard.css';

interface ScoreboardProps {
  title?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeScore?: string | number;
  awayScore?: string | number;
  period?: string;
  showPeriod?: boolean;
  clock?: string;
  showClock?: boolean;
  status?: string;
}

export const Scoreboard: React.FC<ScoreboardProps> = ({
  title = 'MATCH',
  homeTeam = 'HOME',
  awayTeam = 'AWAY',
  homeScore = 0,
  awayScore = 0,
  period = '1ST',
  showPeriod = true,
  clock = '00:00',
  showClock = true,
  status = 'LIVE'
}) => {
  return (
    <div className='scoreboard-shell'>
      <div className='scoreboard-title'>{title}</div>
      <div className='scoreboard-main'>
        <div className='scoreboard-team'>
          <span className='scoreboard-team-label'>{homeTeam}</span>
          <span className='scoreboard-team-score'>{homeScore}</span>
        </div>

        <div className='scoreboard-center'>
          {showPeriod ? <span className='scoreboard-period'>{period}</span> : null}
          {showClock ? <span className='scoreboard-clock'>{clock}</span> : null}
          <span className='scoreboard-status'>{status}</span>
        </div>

        <div className='scoreboard-team'>
          <span className='scoreboard-team-label'>{awayTeam}</span>
          <span className='scoreboard-team-score'>{awayScore}</span>
        </div>
      </div>
    </div>
  );
};
