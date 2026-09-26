import React from 'react';
import { VVF_LOGO_DATA_URL } from '../brand/vvfLogoData';

type BrandMarkProps = {
  size?: number;
  className?: string;
  showWordmark?: boolean;
  compact?: boolean;
};

/** Vishva Vijayaa Foundation brand mark for header / footer. */
export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 32,
  className = '',
  showWordmark = true,
  compact = false,
}) => {
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <img
        src={VVF_LOGO_DATA_URL}
        alt="Vishva Vijayaa Foundation"
        width={size}
        height={size}
        className="rounded-full ring-1 ring-amber-500/30 shadow-sm object-cover shrink-0 bg-zinc-950"
        decoding="async"
      />
      {showWordmark && (
        <div className="min-w-0 leading-tight">
          <div className="font-bold text-sm tracking-tight text-zinc-900 dark:text-zinc-50 truncate">
            Drive Semantic Search
          </div>
          {!compact && (
            <div className="text-[10px] font-medium text-amber-700/90 dark:text-amber-400/90 truncate">
              Vishva Vijayaa Foundation
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const BrandFooter: React.FC = () => (
  <footer className="mt-10 mb-6 px-4 flex flex-col items-center gap-2 text-center">
    <img
      src={VVF_LOGO_DATA_URL}
      alt="Vishva Vijayaa Foundation"
      width={48}
      height={48}
      className="rounded-full ring-1 ring-amber-500/40 shadow-md object-cover bg-zinc-950"
      decoding="async"
    />
    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 max-w-sm leading-relaxed">
      Built with care by <span className="font-semibold text-zinc-700 dark:text-zinc-300">Vishva Vijayaa Foundation</span>
      <br />
      <span className="text-[10px] opacity-80">विजया ददाति विजयम्</span>
    </p>
  </footer>
);
