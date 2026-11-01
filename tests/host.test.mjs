import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { apply, findPython } from '../index.js'
const manifest=process.env.BILI_VISION_DSH_PACKAGE || join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/package.json')

test('installed DSH accepts schemas and persists actual video images', {skip:!existsSync(manifest)}, async () => {
  const req=createRequire(resolve(manifest))
  const load=async name => import(pathToFileURL(req.resolve(name)).href)
  const {Context}=await load('@deepseek-ai/cordis')
  const {LocalAttachmentStore}=await load('@deepseek-ai/dsh-attachment-local')
  const {assertSupportedJsonSchema,validateJsonSchemaValue}=await load('@deepseek-ai/dsh-tools')
  const dir=await mkdtemp(join(tmpdir(),'bili-host-test-'))
  const keys=['BILI_VISION_CACHE','BILI_SESSDATA','BILI_VISION_ASR_MODEL','BILI_VISION_LANG','BILI_VISION_ASR_DEVICE','BILI_VISION_ASR_COMPUTE']
  const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
  try {
    for(const key of keys) process.env[key]=''
    process.env.BILI_VISION_CACHE=join(dir,'cache')
    const python=findPython()
    const fixture=spawnSync(python,['-B',fileURLToPath(new URL('./prepare_fixture.py',import.meta.url)),process.env.BILI_VISION_CACHE],{encoding:'utf8',windowsHide:true,timeout:30000})
    assert.equal(fixture.status,0,fixture.stderr)
    const attachments=new LocalAttachmentStore(new Context(),{dshHome:join(dir,'host')})
    const entries=[]
    apply({tools:{register:t=>entries.push(t)},attachments,llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})}},{python,updateOnBoot:false})
    for(const t of entries){assertSupportedJsonSchema(t.parameters);assertSupportedJsonSchema(t.output.schema)}
    const tool=entries[0]
    const exec={agent:{options:{provider:'fixture',model:'fixture-vision'}},signal:new AbortController().signal}
    const value=await tool.execute({target:'BV1234567890',ocr:false},exec)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema,value,''),[])
    const images=tool.output.render({},value).filter(b=>b.type==='image')
    assert.equal(images.length,3)
    for(const image of images) assert(await attachments.readImage(image.attachment))
    const repeat=await tool.execute({target:'BV1234567890',ocr:false},exec)
    assert.deepEqual(repeat.images,value.images)
    const focused=await tool.execute({target:'BV1234567890',start:7,end:10,ocr:false,maxVision:3},exec)
    assert.equal(focused.images.length,3)
    const summary=await entries[1].execute({target:'BV1234567890'},exec)
    assert.equal(summary.images.length,0)
    assert(summary.text.includes('At second 11'))
  } finally {
    for(const key of keys){if(prior[key]===undefined) delete process.env[key];else process.env[key]=prior[key]}
    await rm(dir,{recursive:true,force:true})
  }
})
