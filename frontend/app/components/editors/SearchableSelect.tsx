import { useMemo, useState } from 'react';
import { Input, Select } from '@gaulatti/bleecker';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  searchPlaceholder = 'Search…',
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  searchPlaceholder?: string;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
  }, [options, query]);
  const selectedOption = options.find((option) => option.value === value);
  const visibleOptions = selectedOption && !filteredOptions.some((option) => option.value === value)
    ? [selectedOption, ...filteredOptions]
    : filteredOptions;

  return (
    <div className='space-y-1.5'>
      <Input
        type='search'
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        className='w-full px-3 py-1.5 text-xs border rounded focus:ring-2 focus:ring-sea/50'
      />
      <Select
        value={value}
        onChange={onChange}
        className={className}
        options={visibleOptions.length > 0 ? visibleOptions : [{ value: '', label: 'No matches found' }]}
      />
    </div>
  );
}
