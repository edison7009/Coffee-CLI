//! Saved tokens and passwords as plain text in `~/.coffee-cli/credentials.json`.
//! Mirrors the small part of the `keyring` API the app used, without the OS
//! credential store and its permission prompts.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

type Store = BTreeMap<String, BTreeMap<String, String>>;

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub enum Error {
    NoEntry,
    Storage(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NoEntry => f.write_str("no saved value"),
            Error::Storage(message) => f.write_str(message),
        }
    }
}

pub struct Entry {
    path: PathBuf,
    service: String,
    account: String,
}

impl Entry {
    pub fn new(service: &str, account: &str) -> Result<Self, Error> {
        let home = dirs::home_dir().ok_or_else(|| Error::Storage("Cannot find the user home directory".into()))?;
        Ok(Self::at(home.join(".coffee-cli").join("credentials.json"), service, account))
    }

    pub(crate) fn at(path: PathBuf, service: &str, account: &str) -> Self {
        Self { path, service: service.into(), account: account.into() }
    }

    pub fn get_password(&self) -> Result<String, Error> {
        let _lock = FILE_LOCK.lock().map_err(|_| Error::Storage("Saved credentials are unavailable".into()))?;
        self.read()?.get(&self.service).and_then(|accounts| accounts.get(&self.account)).cloned().ok_or(Error::NoEntry)
    }

    pub fn set_password(&self, value: &str) -> Result<(), Error> {
        let _lock = FILE_LOCK.lock().map_err(|_| Error::Storage("Saved credentials are unavailable".into()))?;
        let mut store = self.read()?;
        store.entry(self.service.clone()).or_default().insert(self.account.clone(), value.into());
        self.write(&store)
    }

    pub fn delete_credential(&self) -> Result<(), Error> {
        let _lock = FILE_LOCK.lock().map_err(|_| Error::Storage("Saved credentials are unavailable".into()))?;
        let mut store = self.read()?;
        let accounts = store.get_mut(&self.service).ok_or(Error::NoEntry)?;
        accounts.remove(&self.account).ok_or(Error::NoEntry)?;
        if accounts.is_empty() { store.remove(&self.service); }
        self.write(&store)
    }

    fn read(&self) -> Result<Store, Error> {
        match std::fs::read(&self.path) {
            Ok(data) => serde_json::from_slice(&data).map_err(|_| Error::Storage("Saved credentials file is damaged".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::new()),
            Err(error) => Err(Error::Storage(format!("Cannot read saved credentials: {error}"))),
        }
    }

    fn write(&self, store: &Store) -> Result<(), Error> {
        let storage = |error: std::io::Error| Error::Storage(format!("Cannot save credentials: {error}"));
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent).map_err(storage)?; }
        let temporary = self.path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(store).map_err(|error| Error::Storage(error.to_string()))?;
        std::fs::write(&temporary, data).map_err(storage)?;
        crate::agent::replace_file(&temporary, &self.path).map_err(Error::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip_as_plain_text_per_service_and_account() {
        let directory = std::env::temp_dir().join(format!("coffee-credentials-{}", uuid::Uuid::new_v4()));
        let path = directory.join("credentials.json");
        let telegram = Entry::at(path.clone(), "coffee-cli-channels", "telegram-a");
        let ssh = Entry::at(path.clone(), "coffee-cli", "root@example.com");
        assert!(matches!(telegram.get_password(), Err(Error::NoEntry)));
        assert!(matches!(telegram.delete_credential(), Err(Error::NoEntry)));
        telegram.set_password("123:token").unwrap();
        ssh.set_password("pass word").unwrap();
        assert_eq!(telegram.get_password().unwrap(), "123:token");
        let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["coffee-cli"]["root@example.com"], "pass word");
        telegram.set_password("456:new").unwrap();
        assert_eq!(telegram.get_password().unwrap(), "456:new");
        telegram.delete_credential().unwrap();
        assert!(matches!(telegram.get_password(), Err(Error::NoEntry)));
        assert_eq!(ssh.get_password().unwrap(), "pass word");
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, "not json").unwrap();
        assert!(matches!(ssh.get_password(), Err(Error::Storage(_))));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
