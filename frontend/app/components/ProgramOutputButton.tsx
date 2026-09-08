import { IconButton } from '@gaulatti/bleecker';
import { ExternalLink } from 'lucide-react';

interface ProgramOutputButtonProps {
  outputUrl: string | null;
}

export function ProgramOutputButton({ outputUrl }: ProgramOutputButtonProps) {
  return (
    <IconButton
      type='button'
      title={outputUrl ? 'Open Program Output' : 'Register a verified template to open program output'}
      aria-label={outputUrl ? 'Open Program Output' : 'Program output unavailable'}
      onClick={() => {
        if (!outputUrl) return;
        window.open(outputUrl, '_blank', 'noopener,noreferrer');
      }}
      disabled={!outputUrl}
      className='border-sand/20 bg-white text-text-primary hover:bg-sand/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sand/50 dark:bg-dark-sand dark:text-text-primary dark:hover:bg-sand/10'
    >
      <ExternalLink size={16} strokeWidth={1.8} />
    </IconButton>
  );
}
