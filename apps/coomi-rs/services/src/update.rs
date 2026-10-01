use anyhow::Context;
use anyhow::Result;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/Septemc/Coomi/releases/latest";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

pub async fn check_for_update(current_version: &str) -> Result<UpdateCheckResult> {
    let release = Client::builder()
        .timeout(Duration::from_secs(4))
        .build()?
        .get(LATEST_RELEASE_URL)
        .header("user-agent", format!("Coomi/{current_version}"))
        .header("accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json::<GithubRelease>()
        .await
        .context("GitHub release response is invalid")?;
    let latest_version = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_owned();
    anyhow::ensure!(!latest_version.is_empty(), "latest release has no version");
    Ok(UpdateCheckResult {
        current_version: current_version.to_owned(),
        update_available: version_key(&latest_version) > version_key(current_version),
        latest_version,
        release_url: release.html_url,
    })
}

fn version_key(value: &str) -> Vec<u64> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_numerically() {
        assert!(version_key("v2.10.0") > version_key("2.9.9"));
        assert_eq!(version_key("coomi-v2.0.0-beta.1"), vec![2, 0, 0, 1]);
    }
}
