// Provider operations and every browser renderer share one outcome contract.
export type { ConfirmationResult as ConnectionReturnResult } from './connection-confirmation.js';
export type ConnectionFailureReason = 'canceled' | 'exists' | 'provider' | 'verification' | 'ended';
