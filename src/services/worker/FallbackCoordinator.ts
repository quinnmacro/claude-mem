import { ClassifiedProviderError, isClassified, type ProviderErrorClass } from './provider-errors.js';
import { isGeminiAvailable } from './GeminiProvider.js';
import { isOpenRouterAvailable } from './OpenRouterProvider.js';
import { logger } from '../../utils/logger.js';

export type ProviderLabel = 'claude' | 'gemini' | 'openrouter';
const VALID_PROVIDERS: ProviderLabel[] = ['claude', 'gemini', 'openrouter'];
const VALID_FALLBACK_KINDS: ProviderErrorClass[] = ['quota_exhausted', 'auth_invalid', 'rate_limit', 'unrecoverable'];

export class FallbackCoordinator {
  private readonly fallbackOrder: ProviderLabel[];
  private readonly fallbackTriggerKinds: Set<string>;

  constructor(fallbackProviders: string, fallbackErrorKinds: string) {
    const rawOrder = fallbackProviders?.trim() ?? '';
    this.fallbackOrder = rawOrder
      ? rawOrder.split(',').map(s => s.trim().toLowerCase() as ProviderLabel).filter(p => VALID_PROVIDERS.includes(p))
      : [];

    const rawKinds = fallbackErrorKinds?.trim() ?? 'quota_exhausted,auth_invalid,rate_limit';
    this.fallbackTriggerKinds = new Set(
      rawKinds.split(',').map(s => s.trim().toLowerCase()).filter(k => VALID_FALLBACK_KINDS.includes(k as ProviderErrorClass))
    );
  }

  isFallbackEnabled(): boolean {
    return this.fallbackOrder.length > 0;
  }

  shouldFallback(error: unknown): boolean {
    if (!this.isFallbackEnabled()) return false;
    if (!isClassified(error)) return false;
    return this.fallbackTriggerKinds.has(error.kind);
  }

  shouldFallbackForKind(kind: ProviderErrorClass): boolean {
    if (!this.isFallbackEnabled()) return false;
    return this.fallbackTriggerKinds.has(kind);
  }

  getFallbackCandidates(failedProviderLabel: ProviderLabel): ProviderLabel[] {
    return this.fallbackOrder.filter(p => p !== failedProviderLabel && this.isProviderAvailable(p));
  }

  private isProviderAvailable(label: ProviderLabel): boolean {
    switch (label) {
      case 'gemini': return isGeminiAvailable();
      case 'openrouter': return isOpenRouterAvailable();
      case 'claude': return true;
    }
  }

  getFallbackOrder(): ProviderLabel[] {
    return [...this.fallbackOrder];
  }
}