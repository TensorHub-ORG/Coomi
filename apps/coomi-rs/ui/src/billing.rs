use serde_json::{json, Value};

pub fn amount(value: &Value) -> Option<f64> {
    let number = value.as_f64().or_else(|| value.as_str()?.trim().parse().ok())?;
    number.is_finite().then_some(number)
}

/// Preserve each currency; unrecognized 200 JSON must never become a fabricated zero balance.
pub fn normalize_balance(value: &Value) -> Option<Value> {
    let data = value.get("data").filter(|v| v.is_object()).unwrap_or(value);
    if let Some(infos) = value.get("balance_infos").or_else(|| data.get("balance_infos")).and_then(Value::as_array) {
        let balances: Vec<Value> = infos.iter().filter_map(|item| {
            let total = amount(item.get("total_balance")?)?;
            let currency = item.get("currency")?.as_str()?;
            Some(json!({"currency":currency,"amount":total}))
        }).collect();
        if !balances.is_empty() {
            return Some(json!({"balances":balances,"expires_at":data.get("expires_at").cloned().unwrap_or(Value::Null),"exempt":data.get("exempt").cloned().unwrap_or(Value::Null)}));
        }
    }
    if let Some(yuan) = data.get("available_yuan").and_then(amount) {
        let mut balances = vec![json!({"currency":"CNY","amount":yuan})];
        if let Some(lamp) = data.get("lamp_remaining").and_then(amount) { balances.push(json!({"currency":"LAMP","amount":lamp})); }
        return Some(json!({"balances":balances,"expires_at":data.get("expires_at").cloned().unwrap_or(Value::Null)}));
    }
    if let Some(balance) = data.get("totalBalance").or_else(|| data.get("balance")).and_then(amount) {
        return Some(json!({"balances":[{"currency":data.get("currency").and_then(Value::as_str).unwrap_or("CNY"),"amount":balance}]}));
    }
    if let (Some(total), Some(used)) = (data.get("total_credits").and_then(amount), data.get("total_usage").and_then(amount)) {
        return Some(json!({"balances":[{"currency":"USD","amount":total-used}]}));
    }
    if let Some(remaining) = data.get("limit_remaining").and_then(amount) {
        return Some(json!({"balances":[{"currency":"USD","amount":remaining}]}));
    }
    None
}

pub fn endpoint(base: &str, suffix: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() { return Err("invalid provider URL".into()); }
    if !url.username().is_empty() || url.password().is_some() { return Err("provider URL cannot contain credentials".into()); }
    let path = url.path().trim_end_matches('/');
    let root = path.strip_suffix("/v1").unwrap_or(path);
    url.set_path(&format!("{root}/{}", suffix.trim_start_matches('/')));
    url.set_query(None); url.set_fragment(None);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn version_path_is_not_duplicated() {
        assert_eq!(endpoint("https://api.deepseek.com/v1", "/user/balance").unwrap(), "https://api.deepseek.com/user/balance");
        assert_eq!(endpoint("https://relay.test/prefix/v1", "/v1/models").unwrap(), "https://relay.test/prefix/v1/models");
    }
    #[test] fn native_strings_and_currency_are_preserved() {
        let n = normalize_balance(&json!({"balance_infos":[{"currency":"USD","total_balance":"0.016"},{"currency":"CNY","total_balance":"0"}]})).unwrap();
        assert_eq!(n["balances"][0]["currency"], "USD"); assert_eq!(n["balances"][0]["amount"], 0.016);
    }
    #[test] fn arbitrary_success_is_not_money() { assert!(normalize_balance(&json!({"ok":true})).is_none()); }
    #[test] fn negative_and_zero_are_valid() { assert!(normalize_balance(&json!({"balance":"0"})).is_some()); assert!(normalize_balance(&json!({"balance":"-1.2"})).is_some()); }
}
