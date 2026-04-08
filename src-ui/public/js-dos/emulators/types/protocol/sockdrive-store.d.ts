export declare const RAW_STORE = "raw";
export declare const WRITE_STORE = "write";
export interface Store {
    put: (key: number, data: Uint8Array, store: string) => Promise<void>;
    get: (key: number, store: string) => Promise<Uint8Array | null>;
    keys: (store: string) => Promise<number[]>;
    each: (key: number[], store: string, callback: (key: number, data: Uint8Array) => void) => Promise<void>;
    close: () => void;
}
export declare class NoStore implements Store {
    owner: string;
    close(): void;
    put(key: number, data: Uint8Array, store: string): Promise<void>;
    get(range: number, store: string): Promise<Uint8Array | null>;
    keys(store: string): Promise<number[]>;
    each(keys: number[], store: string, callback: (key: number, data: Uint8Array) => void): Promise<void>;
}
export declare function getStore(owner: string): Promise<Store>;
