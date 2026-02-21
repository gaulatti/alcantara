export default function LoadingSpinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-8 h-8 border-2',
    lg: 'w-12 h-12 border-3'
  };

  return (
    <div className='flex items-center justify-center'>
      <div className={`${sizeClasses[size]} border-sea dark:border-accent-blue border-t-transparent dark:border-t-transparent rounded-full animate-spin`} />
    </div>
  );
}
