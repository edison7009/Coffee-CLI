interface DriveInfo {
    ahead_read: number;
    range_count: number;
    dropped_ranges: number[];
    preload_ranges: number[] | "_";
    small_ranges: number[];
    cylinders: number;
    heads: number;
    sectors: number;
    sector_size: number;
    size: number;
    name: string;
    url: string;
    preloadSizeInBytes: number;
    sizeInBytes: number;
    readInBytes: number;
    writeInBytes: number;
}
export interface Drive {
    info: DriveInfo;
    range(sector: number): number;
    readRangeAsync(range: number): void;
    ready(): void;
    write(sector: number, buffer: Uint8Array): void;
    persist(): Promise<Uint8Array | null>;
}
export declare function sockdrive(url: string, _onNewRange: (range: number, buffer: Uint8Array) => void): Promise<Drive>;
export {};
