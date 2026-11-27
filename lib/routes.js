/**
 * HTTP routes serving the workbench.
 *
 * They only exist when the profile runs the Web server; the Agent tool keeps
 * working without them.
 *
 * @module @local/dsh-academic-translator/routes
 */

/** Largest accepted request body. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<any>}
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('The request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('The request body must be a JSON object.')
  return parsed
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {any} value
 */
function sendJson(response, status, value) {
  if (response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Build the route handlers.
 * @param {ReturnType<import('./service.js').createTranslatorService>} service
 */
export function createRoutes(service) {
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function stateHandler(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const projectId = url.searchParams.get('project') ?? undefined
      const payload = await service.state(projectId === undefined ? {} : { projectId })
      sendJson(response, 200, { ok: true, state: payload })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function actionHandler(request, response) {
    try {
      const body = await readJsonBody(request)
      const action = typeof body.action === 'string' ? body.action : ''
      const handler = service.actions[action]
      if (typeof handler !== 'function') {
        sendJson(response, 400, { ok: false, error: { message: `Unknown action: ${action || '(missing)'}` } })
        return
      }
      const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
      const result = await handler(payload)
      sendJson(response, 200, { ok: true, result, state: await service.state({ projectId: payload.projectId ?? result?.projectId }) })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }

  return { stateHandler, actionHandler }
}