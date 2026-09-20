import { makeCorpusKey } from '../lib/contentIndex';
import { ensureValidToken, getAccessToken } from '../lib/firebaseAuth';
import { useDriveAppState } from './useDriveAppState';
import { useDriveHandlers } from './useDriveHandlers';

export function useDriveApp() {
  const state = useDriveAppState();
  const handlers = useDriveHandlers(state);
  return {
    ...state,
    ...handlers,
    makeCorpusKey,
    ensureValidToken,
    getAccessToken,
  };
}
