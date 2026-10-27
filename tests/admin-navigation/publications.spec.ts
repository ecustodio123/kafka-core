import { expect, test, type Page } from '@playwright/test'
const user = '11111111-1111-4111-8111-111111111111'
const publicationId = '10000000-0000-4000-8000-000000000001'
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const original = { id: publicationId, store_id: 1, title: 'Informe local', slug: 'informe-local', summary: null,
  category: 'Informes', publication_type: 'document', content: null, status: 'draft', display_order: 0,
  pdf_storage_path: null as string | null, pdf_original_name: null, pdf_size_bytes: null,
  cover_storage_path: null, published_at: null, created_by: user, created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z' }
async function setup(page: Page, role = 'admin', enabled = true) {
  await page.addInitScript(({ user, role }) => {
    const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll('=','').replaceAll('+','-').replaceAll('/','_')
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token:`${encode({alg:'none'})}.${encode({sub:user,exp:Math.floor(Date.now()/1000)+3600})}.local-test`,
      refresh_token:'local-test-only',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,
      user:{id:user,email:'local@example.com',app_metadata:{global_role:role},user_metadata:{},aud:'authenticated'} }))
  }, { user, role })
  const rows: Record<string, unknown>[] = [{ ...original }]
  const files = new Map<string, Buffer>()
  const calls = { create:0, update:0, upload:0, link:0, sign:0, deletes:0, remove:0, foreign:0, ids:[] as string[] }
  const behavior = { failUpload:false, failLink:0, loseCreate:false, loseUpload:false, loseLink:false, conflict:false, deny:false, listError:false }
  await page.route('**/*',async route => {
    const req=route.request(),url=new URL(req.url())
    if(url.origin!=='http://127.0.0.1:5197'){calls.foreign++;return route.abort()}
    const respond=(json:unknown,status=200)=>route.fulfill({json,status})
    if(url.pathname==='/auth/v1/user')return respond({id:user,email:'local@example.com',app_metadata:{global_role:role},user_metadata:{}})
    if(url.pathname==='/rest/v1/stores')return respond([
      {id:1,name:'LOCAL STORE',slug:'local-store',owner_user_id:user},
      ...(role==='super_admin'?[{id:2,name:'FOREIGN STORE',slug:'foreign-store',owner_user_id:'other'}]:[]),
    ])
    if(url.pathname==='/rest/v1/store_features')return respond([{store_id:Number(url.searchParams.get('store_id')?.slice(3)),services_enabled:false,staff_enabled:false,commerce_enabled:false,publications_enabled:enabled}])
    if(url.pathname==='/rest/v1/publications'){
      const body=['POST','PATCH'].includes(req.method())?req.postDataJSON():null
      const store=Number(url.searchParams.get('store_id')?.slice(3)??body?.store_id),id=url.searchParams.get('id')?.slice(3)
      const result=(data:unknown[])=>respond(req.headers().accept?.includes('vnd.pgrst.object')?data[0]??null:data)
      const matches=()=>rows.filter(row=>row.store_id===store&&(!id||row.id===id))
      if(req.method()==='GET'){
        if(behavior.listError)return respond({message:'local error'},500)
        let data=matches().filter(row=>!url.searchParams.get('status')||url.searchParams.get('status')===`eq.${row.status}`)
        const select=url.searchParams.get('select')
        if(select&&select!=='*')data=data.map(row=>Object.fromEntries(select.split(',').map(key=>[key,row[key]])))
        return result(data)
      }
      if(behavior.deny||(role!=='super_admin'&&(!enabled||store!==1)))return respond({code:'42501'},403)
      if(req.method()==='POST'){
        calls.create++;calls.ids.push(body.id)
        expect(body.status).toBe('draft');expect(body).not.toHaveProperty('pdf_storage_path');expect(body).not.toHaveProperty('created_by')
        if(rows.some(row=>row.id===body.id||row.store_id===store&&row.slug===body.slug))return respond({code:'23505'},409)
        const row={...original,...body,pdf_storage_path:null};rows.push(row)
        if(behavior.loseCreate){behavior.loseCreate=false;return route.abort()}
        return result([row])
      }
      if(req.method()==='DELETE'){calls.deletes++;const data=matches();for(const row of data)rows.splice(rows.indexOf(row),1);return respond(data.map(row=>({id:row.id})))}
      const row=matches()[0];if(!row)return result([])
      if('pdf_storage_path'in body){
        calls.link++;if(behavior.failLink-->0)return respond({message:'link unconfirmed'},500)
        const expected=url.searchParams.get('pdf_storage_path')
        if(expected!==(row.pdf_storage_path==null?'is.null':`eq.${row.pdf_storage_path}`))return result([])
      }else{
        calls.update++
        if(body.status==='published'&&body.publication_type==='document'&&!row.pdf_storage_path)return respond({code:'23514'},400)
        if(body.status==='published'&&!row.published_at)row.published_at='2026-10-26T00:00:00Z'
      }
      Object.assign(row,body)
      if(behavior.loseLink&&'pdf_storage_path'in body){behavior.loseLink=false;return route.abort()}
      return result([row])
    }
    if(url.pathname.startsWith('/storage/v1/')){
      if(req.method()==='DELETE'||req.method()==='PUT'){calls.remove++;return route.abort()}
      if(url.pathname.includes('/object/sign/')){calls.sign++;expect(req.postDataJSON().expiresIn).toBe(60);return respond({signedURL:'/object/sign/publication-files/local.pdf?token=LOCAL-SIMULATED'})}
      const path=decodeURIComponent(url.pathname.split('publication-files/')[1]??'')
      if(req.method()==='POST'){
        calls.upload++;expect(req.headers()['x-upsert']).toBe('false')
        expect(path).toMatch(/^1-local-store\/publications\/[a-f0-9-]+-[a-z0-9-]+\/documento-[a-f0-9-]+\.pdf$/)
        if(behavior.failUpload)return respond({message:'unconfirmed'},500)
        const form=await new Response(new Uint8Array(req.postDataBuffer()!).buffer,{headers:{'Content-Type':req.headers()['content-type']}}).formData()
        const file=[...form.values()].find(v=>v instanceof Blob)as Blob
        files.set(path,Buffer.from(await file.arrayBuffer()))
        if(behavior.conflict)rows[0].pdf_storage_path='1-local-store/publications/other/document.pdf'
        if(behavior.loseUpload){behavior.loseUpload=false;return route.abort()}
        return respond({Key:path})
      }
      return files.has(path)?route.fulfill({body:files.get(path),contentType:'application/pdf'}):respond({code:'NoSuchKey'},404)
    }
    if(url.pathname.startsWith('/rest/'))throw new Error(`Unexpected local API ${url.pathname}`)
    return route.continue()
  })
  await page.goto('/tests/admin-navigation/browser.html')
  await expect(page.getByLabel('Tienda',{exact:true})).toBeEnabled()
  if(enabled||role==='super_admin'){
    await page.getByRole('button',{name:enabled?'Publicaciones':'Publicaciones Deshabilitado',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Informe local',exact:true})).toBeVisible()
  }
  return {rows,files,calls,behavior}
}
async function selectPdf(page: Page,name='local.pdf',bytes=pdf,mimeType='application/pdf') {
  await page.getByLabel('Archivo PDF',{exact:true}).setInputFiles({name,mimeType,buffer:bytes})
  await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled()
}
test('create draft, verify private PDF, link and publish; stable ID and server publication date',async({page})=>{
  const f=await setup(page)
  await page.getByRole('button',{name:'Nueva publicacion',exact:true}).click()
  await page.getByLabel('Titulo',{exact:true}).fill('Informe nuevo')
  await expect(page.getByLabel('Slug',{exact:true})).toHaveValue('informe-nuevo')
  await page.getByLabel('Estado',{exact:true}).selectOption('published')
  await selectPdf(page)
  await page.getByRole('button',{name:'Guardar',exact:true}).dblclick()
  await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  const row=f.rows.find(row=>row.title==='Informe nuevo')!
  expect(row.status).toBe('published');expect(row.published_at).toBeTruthy()
  expect(f.calls).toMatchObject({create:1,upload:1,link:1,update:1,remove:0,foreign:0})
  await page.getByRole('button',{name:'Editar Informe nuevo',exact:true}).click()
  await page.getByLabel('Estado',{exact:true}).selectOption('archived')
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  expect(row.published_at).toBe('2026-10-26T00:00:00Z')
})
for(const invalid of ['mime','signature','oversized'])test(`${invalid}: PDF validation prevents all writes`,async({page})=>{
  const f=await setup(page)
  await page.getByRole('button',{name:'Nueva publicacion',exact:true}).click()
  await selectPdf(page,'bad.pdf',invalid==='signature'?Buffer.from('not pdf'):invalid==='oversized'?Buffer.alloc(10*1024*1024+1):pdf,invalid==='mime'?'image/png':'application/pdf')
  await expect(page.getByRole('alert')).toBeVisible()
  expect(f.calls.create+f.calls.upload+f.calls.link+f.calls.update).toBe(0)
})
for(const scenario of ['failLink','loseUpload','loseLink','conflict']as const)test(`${scenario}: PDF retry never reuploads or overwrites another session`,async({page})=>{
  const f=await setup(page)
  if(scenario==='failLink')f.behavior.failLink=1
  else f.behavior[scenario]=true
  await page.getByRole('button',{name:'Editar Informe local',exact:true}).click()
  await selectPdf(page)
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  if(scenario==='failLink'||scenario==='conflict')await expect(page.getByRole('alert')).toBeVisible()
  if(scenario==='failLink')await page.getByRole('button',{name:'Guardar',exact:true}).click()
  if(scenario!=='conflict')await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  else await expect(page.getByRole('alert')).toContainText('Otra sesion')
  expect(f.calls.upload).toBe(1);expect(f.calls.remove).toBe(0)
})
test('failed upload preserves draft ID and retries verification only',async({page})=>{
  const f=await setup(page);f.behavior.failUpload=true
  await page.getByRole('button',{name:'Nueva publicacion',exact:true}).click()
  await page.getByLabel('Titulo',{exact:true}).fill('Pendiente')
  await selectPdf(page)
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('conserva su ID')
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('No se confirmo el PDF')
  expect(f.calls.create).toBe(1);expect(f.calls.upload).toBe(1)
})
test('lost INSERT response recovers the same UUID without a second record',async({page})=>{
  const f=await setup(page);f.behavior.loseCreate=true
  await page.getByRole('button',{name:'Nueva publicacion',exact:true}).click()
  await page.getByLabel('Titulo',{exact:true}).fill('Creacion recuperada')
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  expect(f.calls.create).toBe(1);expect(f.rows.filter(r=>r.title==='Creacion recuperada')).toHaveLength(1)
})
test('private PDF signing accepts record ID, never arbitrary paths; replacement retains original',async({page})=>{
  const f=await setup(page)
  await page.getByRole('button',{name:'Editar Informe local',exact:true}).click()
  await selectPdf(page)
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  const first=f.rows[0].pdf_storage_path
  await page.getByRole('button',{name:'Ver PDF de Informe local',exact:true}).click()
  await expect(page.getByRole('link',{name:'Abrir o descargar PDF'})).toHaveAttribute('href',/\/storage\/v1\/object\/sign\/publication-files\//)
  await page.getByRole('button',{name:'Editar Informe local',exact:true}).click()
  await selectPdf(page,'replacement.pdf')
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByText('Publicacion guardada correctamente.')).toBeVisible()
  expect(f.rows[0].pdf_storage_path).not.toBe(first);expect(f.files.size).toBe(2);expect(f.calls.remove).toBe(0)
})
test('delete requires confirmation and never removes a PDF; backend denial never shows success',async({page})=>{
  const f=await setup(page)
  page.once('dialog',dialog=>dialog.dismiss())
  await page.getByRole('button',{name:'Eliminar Informe local',exact:true}).click();expect(f.calls.deletes).toBe(0)
  f.behavior.deny=true;page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Eliminar Informe local',exact:true}).click()
  await expect(page.getByRole('alert')).toBeVisible();expect(f.rows).toHaveLength(1)
  f.behavior.deny=false;page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Eliminar Informe local',exact:true}).click()
  await expect(page.getByText('Publicacion eliminada correctamente.')).toBeVisible();expect(f.calls.remove).toBe(0)
})
test('admin cannot navigate to disabled module',async({page})=>{
  await setup(page,'admin',false)
  await expect(page.getByRole('button',{name:/^Publicaciones/})).toHaveCount(0)
})
test('published data helper returns only bounded public metadata, never signs PDFs',async({page})=>{
  const f=await setup(page)
  f.rows[0].status='published';f.rows[0].pdf_storage_path='PRIVATE-PATH'
  const data=await page.evaluate(async()=>{
    const path='/src/services/publications.ts'
    const {listPublishedPublications}=await import(path)
    return listPublishedPublications(1,0,25)
  })
  expect(data).toHaveLength(1)
  expect(data[0]).not.toHaveProperty('pdf_storage_path');expect(data[0]).not.toHaveProperty('created_by')
  expect(f.calls.sign+f.calls.upload+f.calls.update).toBe(0)
})
test('Super Admin sees disabled publications; store switch clears pending form',async({page})=>{
  await setup(page,'super_admin',false)
  await page.getByRole('button',{name:'Editar Informe local',exact:true}).click()
  await page.getByLabel('Titulo',{exact:true}).fill('UNSAVED')
  await page.getByLabel('Tienda',{exact:true}).selectOption('2')
  await expect(page.getByLabel('Titulo',{exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'Publicaciones Deshabilitado',exact:true}).click()
  await expect(page.getByText('No hay publicaciones para mostrar.')).toBeVisible()
})
test('mobile search/filter, publish without PDF validation and responsive form',async({page})=>{
  await page.setViewportSize({width:375,height:812})
  const f=await setup(page)
  await page.getByLabel('Filtrar estado',{exact:true}).selectOption('published')
  await expect(page.getByText('No hay publicaciones para mostrar.')).toBeVisible()
  await page.getByLabel('Filtrar estado',{exact:true}).selectOption('all')
  await page.getByLabel('Buscar por titulo',{exact:true}).fill('missing')
  await expect(page.getByText('No hay publicaciones para mostrar.')).toBeVisible()
  await page.getByRole('button',{name:'Nueva publicacion',exact:true}).click()
  await page.getByLabel('Titulo',{exact:true}).fill('No file')
  await page.getByLabel('Estado',{exact:true}).selectOption('published')
  await page.getByRole('button',{name:'Guardar',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Selecciona un PDF')
  expect(f.calls.create+f.calls.upload+f.calls.update).toBe(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:'test-results/publications-mobile.png',fullPage:true})
  await page.setViewportSize({width:1280,height:800})
  await page.evaluate(async()=>{
    window.scrollTo(0,0)
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  })
  await expect(page.getByRole('heading',{name:'Kafka Admin',exact:true})).toHaveCount(1)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:'test-results/publications-desktop.png',fullPage:true})
})
