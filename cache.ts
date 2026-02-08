import { CacheEngine } from './cache-engine';

const db_name : string= 'DB'
const db_version : number= 1

export const APPCACHE = new CacheEngine({
    dbName: db_name,
    version: db_version,
    storeName: 'Database',
    maxSize: 100 * 1024 * 1024,
    compressionThreshold: 10 * 1024,
});
