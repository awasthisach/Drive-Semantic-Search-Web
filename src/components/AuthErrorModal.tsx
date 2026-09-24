import React from 'react';
import { AlertCircle, Sparkles, X, RefreshCw, ShieldAlert } from 'lucide-react';

interface AuthErrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  errorMessage: string;
  onConnectDemoDrive: () => void;
  onRetrySignIn: () => void;
  isLoading?: boolean;
}

export const AuthErrorModal: React.FC<AuthErrorModalProps> = ({
  isOpen,
  onClose,
  errorMessage,
  onConnectDemoDrive,
  onRetrySignIn,
  isLoading = false,
}) => {
  if (!isOpen) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const isUnauthorizedDomain =
    errorMessage.toLowerCase().includes('unauthorized-domain') ||
    errorMessage.toLowerCase().includes('origin') ||
    errorMessage.toLowerCase().includes('mismatch') ||
    errorMessage.toLowerCase().includes('not authorized');

  return (
    <div
      id="auth-error-modal-backdrop"
      className="fixed inset-0 z-[99999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        id="auth-error-modal-card"
        className="w-full max-w-lg rounded-3xl bg-zinc-900 border border-zinc-700/80 shadow-2xl p-6 sm:p-7 text-zinc-100 space-y-5 animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Google Sign-In स्थिति (Status)
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Google Drive सुरक्षा प्रमाणीकरण संदेश
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Details Box */}
        <div className="rounded-2xl p-4 bg-zinc-950/80 border border-zinc-800 text-xs space-y-2">
          <div className="flex items-center gap-2 text-amber-400 font-semibold">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>ब्राउज़र/क्लाउड रिस्पॉन्स:</span>
          </div>
          <p className="text-zinc-300 font-mono text-[11px] break-all leading-relaxed">
            {errorMessage || 'Unable to complete Google OAuth authentication'}
          </p>
        </div>

        {/* Hindi & English Guidance based on error */}
        <div className="text-xs text-zinc-300 space-y-2.5 leading-relaxed bg-blue-950/30 border border-blue-900/40 p-4 rounded-2xl">
          {isUnauthorizedDomain ? (
            <>
              <p className="font-semibold text-blue-300">
                🌐 डोमेन ऑथराइजेशन की आवश्यकता (Domain Authorization):
              </p>
              <p className="text-zinc-300">
                Google इस origin को नहीं पहचान पा रहा है। इसे ठीक करने के लिए <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-blue-300 underline">Google Cloud Console → Credentials</a> में OAuth 2.0 Client ID की <span className="text-white font-semibold">Authorized JavaScript origins</span> में यह origin (<code className="text-blue-300 bg-blue-950 px-1 py-0.5 rounded font-mono">{currentOrigin}</code>) जोड़ें, और <a href="https://console.firebase.google.com/project/thevvforg/authentication/settings" target="_blank" rel="noreferrer" className="text-blue-300 underline">Firebase Authentication → Authorized domains</a> में <code className="text-blue-300 bg-blue-950 px-1 py-0.5 rounded font-mono">{currentHost}</code> जोड़ें।
              </p>
            </>
          ) : (
            <p className="text-zinc-300">
              Google Drive OAuth सेवा से जुड़ने में समस्या आई है। आप सीधे डेमो मोड से सारे फ़ीचर्स तुरंत टेस्ट कर सकते हैं।
            </p>
          )}
        </div>

        {/* Primary Action Buttons */}
        <div className="space-y-2.5 pt-1">
          {/* 1-Click Demo Drive Connect */}
          <button
            type="button"
            onClick={() => {
              onConnectDemoDrive();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-blue-600/25 transition cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-amber-300 shrink-0" />
            <span>डेमो गूगल ड्राइव से कनेक्ट करें (Instant Demo Drive)</span>
          </button>

          {/* Retry Button */}
          <button
            type="button"
            onClick={onRetrySignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-xs border border-zinc-700 transition cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-blue-400' : ''}`} />
            <span>पुनः Google Sign-In का प्रयास करें (Retry)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
