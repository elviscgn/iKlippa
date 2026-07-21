export type Tier = 'free' | 'klippa' | 'pro';

interface TierConfig {
  maxWidth: number;
  maxHeight: number;
  maxDurationSec: number;
  watermark: boolean;
}

const TIERS: Record<Tier, TierConfig> = {
  free:    { maxWidth: 1280, maxHeight: 720,  maxDurationSec: 60,  watermark: true },
  klippa:  { maxWidth: 1920, maxHeight: 1080, maxDurationSec: 300, watermark: false },
  pro:     { maxWidth: 3840, maxHeight: 2160, maxDurationSec: 900, watermark: false },
};

// Mock — swap for real API in Phase 2
export const currentTier: Tier = 'free';

export function getTierConfig(): TierConfig {
  return TIERS[currentTier];
}
