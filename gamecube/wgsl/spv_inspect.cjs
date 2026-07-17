const fs=require('fs');
const file=process.argv[2];
const target=parseInt(process.argv[3]||'253',10);
const buf=fs.readFileSync(file);
const w=new Uint32Array(buf.buffer,buf.byteOffset,buf.byteLength/4);
// Minimal opcode name table for the ops we care about
const OP={0:'OpNop',71:'OpDecorate',5:'OpName',59:'OpVariable',61:'OpLoad',62:'OpStore',
  15:'OpEntryPoint',16:'OpExecutionMode',17:'OpCapability',11:'OpExtInstImport',12:'OpExtInst',
  19:'OpTypeVoid',20:'OpTypeBool',21:'OpTypeInt',22:'OpTypeFloat',23:'OpTypeVector',24:'OpTypeMatrix',
  25:'OpTypeImage',26:'OpTypeSampler',27:'OpTypeSampledImage',28:'OpTypeArray',32:'OpTypePointer',
  33:'OpTypeFunction',43:'OpConstant',41:'OpConstantComposite',54:'OpFunction',56:'OpFunctionEnd',
  55:'OpFunctionParameter',57:'OpFunctionCall',65:'OpAccessChain',
  156:'OpIsNan',157:'OpIsInf',81:'OpCompositeExtract',80:'OpCompositeConstruct',
  124:'OpBitcast',194:'OpBitFieldSExtract',195:'OpBitFieldUExtract',
  247:'OpSelectionMerge',246:'OpLoopMerge',249:'OpBranch',250:'OpBranchConditional',253:'OpReturn',
  248:'OpLabel',169:'OpFOrdEqual',171:'OpFOrdLessThan',177:'OpLogicalAnd'};
let i=5;
const lines=[];
while(i<w.length){
  const op=w[i]&0xffff;
  const len=w[i]>>16;
  if(len===0){break;}
  // does this instruction have a result id? heuristic: many ops put result at word i+2 (with type at i+1)
  // We'll just print raw operands and flag any that reference target.
  const operands=[];
  for(let k=1;k<len;k++) operands.push(w[i+k]);
  const refsTarget=operands.includes(target);
  const opname=OP[op]||('Op#'+op);
  // detect result id: for ops with result, it's typically operand[0] (if no type) or operand[1] (if type+result)
  lines.push({i,op,opname,len,operands,refsTarget});
  i+=len;
}
// print instructions that define or reference target id, plus extinst imports
console.log('--- ExtInstImport / Capability ---');
for(const l of lines){ if(l.opname==='OpExtInstImport'){ // operand0=result id, rest=string
  const strWords=l.operands.slice(1); let s=''; for(const ww of strWords){ for(let b=0;b<4;b++){const c=(ww>>(b*8))&0xff; if(c)s+=String.fromCharCode(c);}} console.log('  %'+l.operands[0]+' = ExtInstImport "'+s+'"'); }
  if(l.opname==='OpCapability'){ console.log('  Capability',l.operands[0]); }
}
console.log('--- instructions defining or referencing %'+target+' ---');
for(const l of lines){
  // crude: result id is operands[1] for ops with type+result (most arithmetic), operands[0] for some
  const maybeResult = l.operands[1];
  const defines = (maybeResult===target)||(l.operands[0]===target);
  if(defines || l.refsTarget){
    console.log((defines?'DEF ':'use '), l.opname, '(len'+l.len+')', 'ops:[', l.operands.join(','), ']');
  }
}
// Also dump any OpExtInst that look like relational / isnan and the 10 instructions before any use of target
console.log('--- all OpExtInst (GLSL.std.450) opcodes used ---');
const extset=new Set();
for(const l of lines){ if(l.opname==='OpExtInst'){ extset.add(l.operands[3]); } }
console.log('  ext opcodes:', [...extset].sort((a,b)=>a-b).join(','));
