/**
 * Centralized API Error Handling & Normalization
 * 
 * All backend errors are normalized to this structure,
 * making error handling consistent across the app
 */

export type ApiErrorType = 
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'UNKNOWN_ERROR';

export interface NormalizedApiError {
  type: ApiErrorType;
  statusCode: number;
  message: string;
  details?: Record<string, any>;
  code?: string;
  timestamp: string;
}

/**
 * Normalize any error to a consistent structure
 * Backend error format expected:
 * {
 *   success: false,
 *   error: {
 *     code: 'VALIDATION_ERROR',
 *     message: 'Invalid input',
 *     details: { field: [...messages] }
 *   }
 * }
 */
export function normalizeApiError(error: any): NormalizedApiError {
  const timestamp = new Date().toISOString();

  // Network/timeout errors
  if (!error.response) {
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return {
        type: 'TIMEOUT_ERROR',
        statusCode: 408,
        message: 'Request timeout. Please try again.',
        timestamp,
      };
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return {
        type: 'NETWORK_ERROR',
        statusCode: 0,
        message: 'Network error. Please check your connection.',
        timestamp,
      };
    }

    // A8 merchant pass F-6: an error with no HTTP response is a TRANSPORT
    // problem, and its raw axios message is library vocabulary
    // ("Unsupported protocol C:/…", "Request failed with status code 500",
    // "Network Error"). Never echo it at a merchant — render honest transport
    // copy and keep the raw string for debugging only. Backend-authored copy
    // is untouched: it only exists when a response arrived (branch below).
    return {
      type: 'UNKNOWN_ERROR',
      statusCode: 0,
      message: 'Could not reach the service. Please check your connection and try again.',
      details:
        typeof error?.message === 'string'
          ? { transportMessage: error.message }
          : undefined,
      timestamp,
    };
  }

  const status = error.response.status;
  const data = error.response.data;

  // Map HTTP status codes to error types
  let errorType: ApiErrorType = 'UNKNOWN_ERROR';
  if (status === 400) errorType = 'VALIDATION_ERROR';
  else if (status === 401) errorType = 'UNAUTHORIZED';
  else if (status === 403) errorType = 'FORBIDDEN';
  else if (status === 404) errorType = 'NOT_FOUND';
  else if (status === 409) errorType = 'CONFLICT';
  else if (status >= 500) errorType = 'SERVER_ERROR';

  // Extract backend error message
  const message =
    data?.error?.message ||
    data?.message ||
    getDefaultErrorMessage(status);

  const details =
    data?.error?.details ||
    data?.details;

  return {
    type: errorType,
    statusCode: status,
    message,
    details,
    code: data?.error?.code ?? data?.code,
    timestamp,
  };
}

function getDefaultErrorMessage(status: number): string {
  const messages: Record<number, string> = {
    400: 'Invalid request. Please check your input.',
    401: 'Unauthorized. Please login again.',
    403: 'You do not have permission to perform this action.',
    404: 'Resource not found.',
    409: 'Conflict. This resource already exists.',
    500: 'Server error. Please try again later.',
    503: 'Service unavailable. Please try again later.',
  };

  return messages[status] || 'An error occurred. Please try again.';
}

/**
 * Check if error is a specific type
 * Usage: isApiError(error, 'VALIDATION_ERROR')
 */
export function isApiError(
  error: any,
  type?: ApiErrorType
): error is NormalizedApiError {
  if (!error || typeof error !== 'object') return false;
  if (!('type' in error) || !('statusCode' in error)) return false;
  if (type && error.type !== type) return false;
  return true;
}

/**
 * Get user-friendly error message for display.
 *
 * Pass a translated `fallback` at UI call sites — it is used whenever the error
 * carries no message of its own, so the merchant sees Bangla rather than the
 * hardcoded English default:
 *   toast.error(getErrorMessage(err, t('orders.errors.loadFailed')))
 *
 * Note the argument is the error the axios interceptor threw, i.e. already a
 * NormalizedApiError. It has no `.response` — reading `err.response.data.error.message`
 * always yields undefined.
 */
export function getErrorMessage(
  error: any,
  fallback = 'An unexpected error occurred'
): string {
  if (isApiError(error)) {
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

/**
 * Get field-level validation errors
 * Usage: const errors = getValidationErrors(error);
 *        errors?.email?.join(', ')
 */
export function getValidationErrors(
  error: any
): Record<string, string[]> | undefined {
  if (isApiError(error, 'VALIDATION_ERROR') && error.details) {
    return error.details;
  }
  return undefined;
}
