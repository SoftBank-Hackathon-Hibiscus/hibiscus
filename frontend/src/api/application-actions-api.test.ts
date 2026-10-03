import {describe,expect,it,vi} from 'vitest';
import {RealDataSource} from './real';
describe('application actions',()=>{
  it('encodes assignment identifiers and sends routing revision for concurrency checks',async()=>{
    const fetchImpl=vi.fn(async (_path:string,_options?:RequestInit)=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
    const source=new RealDataSource(fetchImpl);
    await source.assignApplicationAgent('app/id','agent/id');
    await source.changeRouting('app/id','target-id',7);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/applications/app%2Fid/agents/agent%2Fid');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/applications/app%2Fid/routing');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({target_id:'target-id',expected_revision:7,reason:'Console manual switch'});
  });
  it('loads a page of commits for the linked application', async()=>{
    const fetchImpl=vi.fn(async (_path:string)=>new Response(JSON.stringify({commits:[],page:2,branch:'main',hasMore:false}),{status:200}));
    const source=new RealDataSource(fetchImpl);
    const page=await source.listApplicationCommits('app/id',2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/github/applications/app%2Fid/commits?page=2');
    expect(page.branch).toBe('main');
    await source.listApplicationCommits('app/id',1,'a'.repeat(40));
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/github/applications/app%2Fid/commits?page=1&revision='+ 'a'.repeat(40));
  });

  it('disconnects an application agent with encoded identifiers',async()=>{
    const fetchImpl=vi.fn(async(_path:string,_options?:RequestInit)=>new Response('{}',{status:200}));
    await new RealDataSource(fetchImpl).unassignApplicationAgent('app/id','agent/id');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/applications/app%2Fid/agents/agent%2Fid');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

});
