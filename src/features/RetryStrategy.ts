/**
 * Calculates the next run time for a failed job using exponential backoff.
 * 
 * Formula: delay = baseDelay * (2 ^ attempts)
 * 
 * @param attempts The number of times the job has already failed.
 * @param baseDelayMs The base delay in milliseconds (default: 1000ms).
 * @param maxDelayMs The maximum allowed delay to cap the backoff (default: 1 hour).
 * @returns A Date object representing when the job should be retried.
 */
export function calculateExponentialBackoff(
    attempts: number, 
    baseDelayMs: number = 1000, 
    maxDelayMs: number = 60 * 60 * 1000
): Date {
    // 2 ^ attempts
    let delay = baseDelayMs * Math.pow(2, attempts);
    
    // Cap at maximum delay
    if (delay > maxDelayMs) {
        delay = maxDelayMs;
    }

    return new Date(Date.now() + delay);
}
