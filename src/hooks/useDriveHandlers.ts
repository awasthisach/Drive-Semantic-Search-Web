import type { DriveAppState } from './useDriveAppState';
import { useDriveHandlersCore } from './useDriveHandlersCore';
import { useDriveHandlersRest } from './useDriveHandlersRest';

export function useDriveHandlers(s: DriveAppState) {
  return {
    ...useDriveHandlersCore(s),
    ...useDriveHandlersRest(s),
  };
}
