import type { ServerGenerationContext, ServerGenerationProvider, ServerGenerationResult } from './shared/types.js';
import { ServerClassifiedProviderError, isServerClassified, type ServerProviderErrorClass } from './shared/error-classification.js';
import { logger } from '../../../utils/logger.js';

type ServerProviderLabel = 'claude' | 'gemini' | 'openrouter';
const FALLBACK_TRIGGER_KINDS: Set<ServerProviderErrorClass> = new Set(['quota_exhausted', 'auth_invalid', 'rate_limit']);

export class FallbackServerGenerationProvider implements ServerGenerationProvider {
  readonly providerLabel: ServerProviderLabel;
  private readonly providers: ServerGenerationProvider[];

  constructor(primary: ServerGenerationProvider, fallbacks: ServerGenerationProvider[]) {
    this.providerLabel = primary.providerLabel;
    this.providers = [primary, ...fallbacks];
  }

  async generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult> {
    for (const provider of this.providers) {
      try {
        const result = await provider.generate(context, signal);
        if (provider !== this.providers[0]) {
          logger.info('FALLBACK', `Server generation fallback to '${provider.providerLabel}' succeeded`, {
            projectId: context.project.projectId,
            originalProvider: this.providers[0].providerLabel,
            fallbackProvider: provider.providerLabel,
          });
        }
        return result;
      } catch (error: unknown) {
        const classified = isServerClassified(error) ? error : null;
        const kind = classified?.kind;

        if (!kind || !FALLBACK_TRIGGER_KINDS.has(kind)) {
          // Not a fallback-triggering error — throw immediately
          throw error;
        }

        const nextIndex = this.providers.indexOf(provider) + 1;
        if (nextIndex >= this.providers.length) {
          // No more fallback candidates — throw the last error
          logger.error('FALLBACK', `All server generation fallbacks exhausted`, {
            projectId: context.project.projectId,
            providersAttempted: this.providers.map(p => p.providerLabel),
            lastErrorKind: kind,
          });
          throw error;
        }

        logger.warn('FALLBACK', `Server provider '${provider.providerLabel}' failed with kind '${kind}' — falling back to '${this.providers[nextIndex].providerLabel}'`, {
          projectId: context.project.projectId,
          failedProvider: provider.providerLabel,
          fallbackProvider: this.providers[nextIndex].providerLabel,
          errorKind: kind,
          errorMessage: (error as Error)?.message || String(error),
        });
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new ServerClassifiedProviderError('All fallback providers exhausted', {
      kind: 'unrecoverable',
      cause: null,
    });
  }
}