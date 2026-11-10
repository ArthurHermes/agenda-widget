//! Login OAuth (app desktop + PKCE, redirecionamento para 127.0.0.1) e chamadas
//! à Google Calendar API. Os refresh tokens ficam no Gerenciador de Credenciais
//! do Windows; o JavaScript nunca vê nenhum token.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use crate::read_config;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API_BASE: &str = "https://www.googleapis.com";
const SCOPES: &str =
    "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const KEYRING_SERVICE: &str = "agenda-widget";

/// Cache de access tokens em memória: conta -> (token, expira em).
#[derive(Default)]
pub struct Tokens(Mutex<HashMap<String, (String, Instant)>>);

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agenda-widget/0.2")
        .build()
        .expect("cliente http")
}

fn random_string(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn credentials(app: &AppHandle) -> Result<(String, String), String> {
    let cfg = read_config(app);
    let id = cfg["google"]["client_id"].as_str().unwrap_or("").trim().to_string();
    let secret = cfg["google"]["client_secret"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() || secret.is_empty() {
        return Err("Preencha o Client ID e o Client Secret do Google nas configurações.".into());
    }
    Ok((id, secret))
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

fn google_error(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    Some(
        err.get("message")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| {
                let code = err.as_str().unwrap_or("erro");
                let desc = v.get("error_description").and_then(Value::as_str).unwrap_or("");
                Some(format!("{code} {desc}").trim().to_string())
            })
            .unwrap_or_else(|| err.to_string()),
    )
}

// ---------- Login ----------

async fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let path = request
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/");
        let url = reqwest::Url::parse(&format!("http://localhost{path}")).map_err(|e| e.to_string())?;
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();

        let (status, message, result) = if let Some(err) = params.get("error") {
            ("200 OK", "Login cancelado. Pode fechar esta aba.", Some(Err(format!("Login cancelado ({err})"))))
        } else if let Some(code) = params.get("code") {
            if params.get("state").map(String::as_str) != Some(expected_state) {
                ("400 Bad Request", "Resposta inválida. Tente de novo.", Some(Err("state OAuth não confere".into())))
            } else {
                ("200 OK", "Conta conectada! Pode fechar esta aba e voltar ao widget.", Some(Ok(code.clone())))
            }
        } else {
            ("404 Not Found", "", None)
        };

        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Agenda Widget</title>\
             <body style=\"font:16px Segoe UI,sans-serif;background:#10131b;color:#eef1f6;\
             display:grid;place-items:center;height:100vh;margin:0\"><p>{message}</p>"
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;

        if let Some(result) = result {
            return result;
        }
    }
}

/// Abre o navegador para o login do Google e devolve {id, email} da conta conectada.
#[tauri::command]
pub async fn google_login(app: AppHandle, tokens: State<'_, Tokens>) -> Result<Value, String> {
    let (client_id, client_secret) = credentials(&app)?;

    let verifier = random_string(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_string(24);

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("access_type", "offline"),
            ("prompt", "consent select_account"),
        ],
    )
    .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(listener, &state))
        .await
        .map_err(|_| "Tempo esgotado esperando o login no navegador.".to_string())??;

    let tok: Value = http()
        .post(TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", &verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(e) = google_error(&tok) {
        return Err(e);
    }
    let access = tok["access_token"].as_str().ok_or("Google não devolveu access_token")?.to_string();
    let refresh = tok["refresh_token"]
        .as_str()
        .ok_or("Google não devolveu refresh_token. Remova o acesso do app em myaccount.google.com/permissions e tente de novo.")?;
    let expires = tok["expires_in"].as_u64().unwrap_or(3600);

    // O id da agenda "primary" é o e-mail da conta.
    let primary: Value = http()
        .get(format!("{API_BASE}/calendar/v3/calendars/primary"))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(e) = google_error(&primary) {
        return Err(e);
    }
    let email = primary["id"].as_str().ok_or("Não consegui identificar a conta")?.to_string();

    keyring_entry(&email)?.set_password(refresh).map_err(|e| e.to_string())?;
    tokens.0.lock().unwrap().insert(
        email.clone(),
        (access, Instant::now() + Duration::from_secs(expires)),
    );

    Ok(json!({ "id": email, "email": email }))
}

#[tauri::command]
pub async fn google_logout(account: String, tokens: State<'_, Tokens>) -> Result<(), String> {
    tokens.0.lock().unwrap().remove(&account);
    let entry = keyring_entry(&account)?;
    if let Ok(refresh) = entry.get_password() {
        // Revoga no Google (melhor esforço) e apaga do cofre do Windows.
        let _ = http().post(REVOKE_URL).form(&[("token", refresh.as_str())]).send().await;
    }
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- Access token + chamadas à API ----------

async fn access_token(app: &AppHandle, tokens: &Tokens, account: &str) -> Result<String, String> {
    if let Some((tok, exp)) = tokens.0.lock().unwrap().get(account) {
        if *exp > Instant::now() + Duration::from_secs(60) {
            return Ok(tok.clone());
        }
    }
    let (client_id, client_secret) = credentials(app)?;
    let refresh = keyring_entry(account)?
        .get_password()
        .map_err(|_| format!("{account}: conta desconectada, conecte de novo nas configurações."))?;

    let tok: Value = http()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", &client_secret),
            ("refresh_token", &refresh),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if tok["error"].as_str() == Some("invalid_grant") {
        return Err(format!("{account}: o acesso expirou ou foi revogado, reconecte a conta nas configurações."));
    }
    if let Some(e) = google_error(&tok) {
        return Err(e);
    }
    let access = tok["access_token"].as_str().ok_or("sem access_token")?.to_string();
    let expires = tok["expires_in"].as_u64().unwrap_or(3600);
    tokens.0.lock().unwrap().insert(
        account.to_string(),
        (access.clone(), Instant::now() + Duration::from_secs(expires)),
    );
    Ok(access)
}

/// Faz uma chamada autenticada à Calendar API em nome de `account`.
/// `path` precisa começar com /calendar/v3/ e já vir com os segmentos codificados.
#[tauri::command]
pub async fn google_request(
    app: AppHandle,
    tokens: State<'_, Tokens>,
    account: String,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<Value, String> {
    if !path.starts_with("/calendar/v3/") || path.contains("..") {
        return Err("caminho de API não permitido".into());
    }
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut url = reqwest::Url::parse(&format!("{API_BASE}{path}")).map_err(|e| e.to_string())?;
    if let Some(q) = &query {
        url.query_pairs_mut().extend_pairs(q);
    }

    for attempt in 0..2 {
        let token = access_token(&app, &tokens, &account).await?;
        let mut req = http().request(method.clone(), url.clone()).bearer_auth(&token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();

        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            tokens.0.lock().unwrap().remove(&account);
            continue;
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if !status.is_success() {
            return Err(google_error(&value).unwrap_or_else(|| format!("HTTP {status}")));
        }
        return Ok(value);
    }
    Err("não autorizado".into())
}
