import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
let root;
window.unmountServiceFlow=()=>{if(root){root.unmount();root=null}};
window.mountServiceFlow=(element,version)=>{
 const nodes=[
 {id:'public',type:'input',position:{x:0,y:90},sourcePosition:Position.Right,data:{label:<><strong>Hibiscus 공개 주소</strong><div>demo-app.apps.example</div><small>4.3건/초 유입</small></>}},
 {id:'cloud',type:'output',position:{x:420,y:0},targetPosition:Position.Left,data:{label:<><strong>Cloud Run · {version}</strong><div>현재 서비스 · 정상</div><small>4.3건/초 · HTTP 200</small></>},style:{borderColor:'#44736a',background:'#f1f8f4'}},
 {id:'prem',type:'output',position:{x:420,y:180},targetPosition:Position.Left,data:{label:<><strong>On-Prem · {version}</strong><div>대기 · 정상</div><small>0건/초 · Agent online</small></>}}
 ];
 const edges=[{id:'active',source:'public',target:'cloud',animated:true,label:'100% · 4.3건/초',style:{stroke:'#44736a',strokeWidth:2},markerEnd:{type:MarkerType.ArrowClosed,color:'#44736a'}},{id:'standby',source:'public',target:'prem',label:'대기 · 0건/초',style:{stroke:'#a5b1ae',strokeDasharray:'5 5'},markerEnd:{type:MarkerType.ArrowClosed,color:'#a5b1ae'}}];
 root=createRoot(element);root.render(<ReactFlow defaultNodes={nodes} defaultEdges={edges} fitView fitViewOptions={{padding:0.2}} nodesDraggable nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} minZoom={0.4} maxZoom={1.5}><Background color="#d9e0dc" gap={20}/><Controls showInteractive={false}/></ReactFlow>);
};
