import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, runPy, findPython } from '../index.js'

function registry(extra = {}) {
  const entries = []
  apply({ tools: { register: t => entries.push(t) }, ...extra }, { updateOnBoot: false })
  return entries
}
test('registers valid object schemas and exposes native image rendering', () => {
  const entries = registry()
  assert.equal(entries.length, 2)
  for (const t of entries) {
    assert.equal(t.parameters.type, 'object')
    assert.deepEqual(t.parameters.required, ['target'])
  }
  const ref = { attachmentId: 'fixture', mediaType: 'image/jpeg', bytes: 20, width: 4, height: 4 }
  const content = entries[0].output.render({}, { text: 'evidence', images: [ref] })
  assert.deepEqual(content, [{ type: 'text', text: 'evidence' }, { type: 'image', attachment: ref }])
})
test('validates parameters before Python or network work', async () => {
  const t = registry()[0]
  await assert.rejects(t.execute({ target: 'BV1234567890', maxVision: -1 }), /超出范围/)
  await assert.rejects(t.execute({ target: 'BV1234567890', start: 10, end: 5 }), /start/)
  await assert.rejects(t.execute({ target: 'BV1234567890', gridSize: 3 }), /选项/)
  await assert.rejects(t.execute({ target: 'BV1234567890', ocr: 'false' }), /类型/)
  await assert.rejects(t.execute({ target: '' }), /target/)
})
test('missing attachment service cannot silently claim to deliver images', async () => {
  await assert.rejects(registry()[0].execute({ target: 'BV1234567890' }), /附件服务/)
})
test('text-only model cannot silently claim to see images', async () => {
  const t = registry({ attachments: { saveImages() {} }, llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } })[0]
  const exec = { agent: { options: { provider: 'fixture', model: 'text-only' } } }
  await assert.rejects(t.execute({ target: 'BV1234567890' }, exec), /不支持图片/)
})
test('already aborted calls never start a subprocess', () => {
  const controller = new AbortController(); controller.abort(new Error('cancel-fixture'))
  assert.throws(() => runPy('not-an-executable', [], { signal: controller.signal }), /cancel-fixture/)
})
test('CLI validation errors propagate as errors, not successful tool text', async () => {
  await assert.rejects(runPy(findPython(), ['inspect', 'invalid-target']), /视频处理失败/)
})
