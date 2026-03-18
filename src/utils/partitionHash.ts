import crypto from 'crypto';

/**
 * Deterministically hashes a string (like a job name or ID) to a partition index.
 *
 * @param key The key to hash
 * @param partitionCount Total number of partitions
 * @returns An integer between 0 and partitionCount - 1
 */
export function getPartitionIndex(key: string, partitionCount: number): number {
    if (partitionCount <= 0) return 0;
    if (partitionCount === 1) return 0;

    // Fast deterministic hash (MD5 is sufficient for distribution, not used for security)
    const hashHexString = crypto.createHash('md5').update(key).digest('hex');
    
    // Take the first 8 characters and parse as a base 16 integer
    const parsedInt = parseInt(hashHexString.substring(0, 8), 16);
    
    return parsedInt % partitionCount;
}
