/**
 * Calculates the next polling delay with random jitter.
 * Jitter prevents the "Thundering Herd" problem where multiple workers
 * wake up and query the database at the exact same millisecond.
 *
 * @param baseInterval The base interval in milliseconds.
 * @param jitterMax The maximum jitter to add in milliseconds.
 * @returns The calculated delay in milliseconds.
 */
export function calculatePollDelay(baseInterval: number, jitterMax: number = 100): number {
    const jitter = Math.floor(Math.random() * jitterMax);
    return baseInterval + jitter;
}
