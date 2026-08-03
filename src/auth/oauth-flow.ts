import crypto from 'crypto'
import * as authManager from './oauth-manager'

const CLIENT_ID =
  process.env.ANTHROPIC_OAUTH_CLIENT_ID ||
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

interface PKCE {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

function generatePKCE(): PKCE {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url')

  return { verifier, challenge }
}

export function getAuthorizationUrl(pkce: PKCE, state: string): string {
  const authUrl = new URL('https://claude.ai/oauth/authorize')
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set(
    'scope',
    'org:create_api_key user:profile user:inference',
  )
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  return authUrl.toString()
}

async function startAuthFlow(): Promise<TokenResponse> {
  const pkce = generatePKCE()
  const authUrl = getAuthorizationUrl(pkce, pkce.verifier)

  console.log('\n🔐 OAuth Authentication Required')
  console.log('Please visit the following URL to authenticate:')
  console.log(`\n${authUrl}\n`)
  console.log('After authentication, you will get a code.')
  console.log('Please paste the entire code here and press Enter:\n')

  // Read code from stdin
  const code = await readCodeFromStdin()

  if (!code) {
    throw new Error('No code provided')
  }

  // Exchange code for tokens
  return await exchangeCodeForTokens(code, pkce.verifier)
}

async function readCodeFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let code = ''
    process.stdin.setEncoding('utf8')
    process.stdin.resume()

    process.stdin.on('data', (chunk) => {
      code += chunk
      if (code.includes('\n')) {
        process.stdin.pause()
        resolve(code.trim())
      }
    })
  })
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const splits = code.split('#')

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1] || verifier,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000), // 30s timeout for token exchange
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code: ${error}`)
  }

  const data = (await response.json()) as TokenResponse

  // Save tokens
  await authManager.set({
    type: 'oauth',
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  })

  console.log('✅ OAuth tokens saved successfully!')

  return data
}

// New function to generate auth URL and store PKCE verifier
export async function generateAuthSession(): Promise<{
  authUrl: string
  sessionId: string
}> {
  const pkce = generatePKCE()
  // 0008 TL1: server-issued random `state` (NOT the verifier). We store
  // state → verifier server-side; the callback must present a state we issued,
  // which is what makes a forged/unsolicited callback fail (CSRF protection).
  const state = crypto.randomBytes(32).toString('base64url')
  const authUrl = getAuthorizationUrl(pkce, state)
  await authManager.setOAuthState(state, pkce.verifier)

  // `sessionId` (field kept for UI back-compat) is now the state, not the verifier.
  return { authUrl, sessionId: state }
}

// New function to handle OAuth callback
export async function handleOAuthCallback(
  code: string,
  state: string,
): Promise<TokenResponse> {
  // 0008 TL1: resolve the verifier from the server-issued state (single-use).
  // No matching state → reject. This blocks a forged/unsolicited callback from
  // overwriting the stored upstream credential with attacker-controlled tokens.
  const verifier = await authManager.takeOAuthState(state)
  if (!verifier) {
    throw new Error('Invalid or expired OAuth state')
  }

  return await exchangeCodeForTokens(code, verifier)
}

export async function login(): Promise<boolean> {
  try {
    // Check if we already have valid credentials
    const existing = await authManager.get()
    if (existing && existing.access && existing.expires > Date.now()) {
      console.log('✅ Valid OAuth credentials already exist')
      return true
    }

    // Start OAuth flow
    await startAuthFlow()
    return true
  } catch (error) {
    console.error('OAuth login failed:', error)
    return false
  }
}

export async function logout(): Promise<boolean> {
  try {
    await authManager.remove()
    console.log('✅ OAuth credentials removed')
    return true
  } catch (error) {
    console.error('Logout failed:', error)
    return false
  }
}
