import React from 'react';
import { User, LogOut, CheckCircle2, RefreshCw, Loader2 } from 'lucide-react';

interface LoginProps {
  userEmail: string;
  userName: string;
  avatarUrl: string;
  isConnected: boolean;
  isLoading?: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onSyncDrive?: () => void;
}

export const Login: React.FC<LoginProps> = ({
  userEmail,
  userName,
  avatarUrl,
  isConnected,
  isLoading = false,
  onSignIn,
  onSignOut,
  onSyncDrive,
}) => {
  if (!isConnected) {
    return (
      <button
        id="google-signin-btn"
        type="button"
        onClick={onSignIn}
        disabled={isLoading}
        aria-label="Sign in with Google"
        className="gsi-material-button inline-flex items-center justify-center gap-2.5 px-3 py-1.5 rounded-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/80 shadow-xs transition-all text-xs font-semibold min-h-[38px] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
        ) : (
          <div className="w-4 h-4 shrink-0">
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-4 h-4 block">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
              <path fill="none" d="M0 0h48v48H0z"></path>
            </svg>
          </div>
        )}
        <span className="whitespace-nowrap">Sign in with Google</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/60 min-h-[36px]">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={userName}
            className="w-6 h-6 rounded-full ring-1 ring-zinc-300 dark:ring-zinc-600 object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="w-6 h-6 rounded-full ring-1 ring-zinc-300 dark:ring-zinc-600 bg-blue-600/10 text-blue-600 flex items-center justify-center">
            <User className="w-3.5 h-3.5" />
          </span>
        )}
        <div className="hidden sm:block text-left" title={userEmail || userName}>
          <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 leading-none truncate max-w-[120px]">
            {userName}
          </p>
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-0.5">
            <CheckCircle2 className="w-2.5 h-2.5" /> Google Drive Connected
          </span>
        </div>
      </div>

      {onSyncDrive && (
        <button
          id="sync-drive-header-btn"
          type="button"
          onClick={onSyncDrive}
          disabled={isLoading}
          title="Sync Google Drive files now"
          className="p-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition min-h-[36px] min-w-[36px] flex items-center justify-center touch-manipulation cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-500' : ''}`} />
        </button>
      )}

      <button
        id="account-signout-btn"
        type="button"
        onClick={onSignOut}
        title="Sign Out of Google Drive"
        className="p-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 hover:text-rose-600 dark:text-zinc-300 dark:hover:text-rose-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition min-h-[36px] min-w-[36px] flex items-center justify-center touch-manipulation cursor-pointer"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
