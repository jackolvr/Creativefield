#!/usr/bin/env node
/* Code map: which file imports which, read from the TypeScript syntax tree (no guessed edges).
   Writes one self-contained HTML page with an area view, a file graph, the blast radius of each
   file (everything that depends on it, directly or through others) and the import cycles.

   node scripts/code-map.mjs [output.html] [--tests]
   Default output: output/code-map.html (local only; it names private files, so it is never published). */
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from "node:fs";
import {dirname,join,relative,resolve} from "node:path";
import ts from "typescript";

const root=resolve(import.meta.dirname,"..");
const args=process.argv.slice(2);
const withTests=args.includes("--tests");
const out=resolve(root,args.find(a=>!a.startsWith("--"))??"output/code-map.html");
const ROOTS=["src","server",...(withTests?["test"]:[])];
const CODE=/\.(ts|tsx|mts|cts)$/;
const LINKED=/\.(ts|tsx|mts|cts|css|json)$/;
const SKIP_DIR=new Set(["node_modules","dist","generated"]);

const posix=p=>p.split("\\").join("/");
function walk(dir,acc=[]){
  for(const name of readdirSync(dir)){
    if(SKIP_DIR.has(name)||name.startsWith("."))continue;
    const full=join(dir,name),info=statSync(full);
    if(info.isDirectory())walk(full,acc);
    else if(CODE.test(name)&&!name.endsWith(".d.ts"))acc.push(posix(relative(root,full)));
  }
  return acc;
}
const sources=ROOTS.filter(r=>existsSync(join(root,r))).flatMap(r=>walk(join(root,r)));

/* An area is the folder a file belongs to, two levels deep: src/team, src/film-studio, server/analysis. */
function areaOf(file){
  const parts=file.split("/");
  if(parts[0]==="src"&&parts.length>2)return parts[1]==="film-studio"&&parts[2]==="vendor"?"src/film-studio/vendor":`src/${parts[1]}`;
  if(parts[0]==="server"&&parts.length>2)return `server/${parts[1]}`;
  return parts[0];
}

const EXT=["",".ts",".tsx",".mts",".cts",".d.ts","/index.ts","/index.tsx"];
function resolveImport(from,spec){
  if(!spec.startsWith("."))return undefined;
  const base=posix(join(dirname(from),spec));
  const bare=base.replace(/\.(m|c)?js$/,"");
  for(const candidate of [base,bare])for(const ext of EXT){
    const path=candidate+ext;
    if(LINKED.test(path)&&existsSync(join(root,path))&&statSync(join(root,path)).isFile())return path;
  }
  return undefined;
}
const packageOf=spec=>spec.startsWith("node:")?"node:"+spec.slice(5).split("/")[0]:spec.startsWith("@")?spec.split("/").slice(0,2).join("/"):spec.split("/")[0];

/* What a file is about, in its own words: the first comment before its code (or after its imports),
   else the doc comment of its first export. Comments that only switch tools off are skipped. */
const NOISE=/^(eslint|@ts-|prettier|biome|istanbul|c8|#region|global |jshint|@vitest|@jsx|@license|copyright|spdx)/i;
function cleanComment(raw){
  const body=raw.startsWith("//")?raw.replace(/^\/\/\s?/gm,""):raw.replace(/^\/\*\*?|\*\/$/g,"").replace(/^\s*\* ?/gm,"");
  const text=body.split("\n").filter(line=>!/^\s*@(param|returns?|example|see|throws)\b/.test(line)).join(" ").replace(/\s+/g," ").trim();
  return NOISE.test(text)||text.length<12?"":text;
}
function sentences(text,max=320){
  if(text.length<=max)return text;
  const cut=text.slice(0,max),end=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf(": "));
  return (end>max*.45?cut.slice(0,end+1):cut.replace(/\s+\S*$/,"")+" …");
}
/* Comments before `pos`. `detached` keeps only those a blank line separates from the code after them:
   those speak for the file, while a comment that touches a declaration speaks for that declaration. */
function commentsBefore(text,pos,detached=false){
  const ranges=ts.getLeadingCommentRanges(text,pos)??[];
  let start=pos;while(start<text.length&&/\s/.test(text[start]))start++;
  return ranges.filter((r,k)=>!detached||/\n[ \t]*\r?\n/.test(text.slice(r.end,(ranges[k+1]?.pos)??start))).map(r=>cleanComment(text.slice(r.pos,r.end))).filter(Boolean);
}
const nameOf=st=>ts.isVariableStatement(st)?st.declarationList.declarations.map(d=>ts.isIdentifier(d.name)?d.name.text:"").filter(Boolean).join(", "):st.name&&ts.isIdentifier(st.name)?st.name.text:"";
/* What a file is about, and whether those are the file's own words ("file") or its first export's ("export"). */
function purposeOf(sf,text){
  const statements=sf.statements;
  const firstCode=statements.find(st=>!ts.isImportDeclaration(st)&&!ts.isImportEqualsDeclaration(st));
  // Above the imports: always about the file.
  const top=statements.length&&(ts.isImportDeclaration(statements[0])||ts.isImportEqualsDeclaration(statements[0]))?commentsBefore(text,0):commentsBefore(text,0,true);
  if(top.length)return {d:sentences(top.join(" ")),src:"file"};
  // Right after the imports, set apart by a blank line: the file explaining itself.
  if(firstCode&&firstCode!==statements[0]){const after=commentsBefore(text,firstCode.pos,true);if(after.length)return {d:sentences(after.join(" ")),src:"file"};}
  for(const st of statements){
    const exported=ts.canHaveModifiers(st)&&ts.getModifiers(st)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
    if(!exported)continue;const found=commentsBefore(text,st.pos);if(found.length)return {d:sentences(found.join(" ")),src:"export",of:nameOf(st)};
  }
  return {d:"",src:""};
}
function exportsOf(sf){
  const names=[];
  for(const st of sf.statements){
    const exported=ts.canHaveModifiers(st)&&ts.getModifiers(st)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
    if(ts.isExportAssignment(st)){names.push("default");continue;}
    if(ts.isExportDeclaration(st)&&st.exportClause&&ts.isNamedExports(st.exportClause)){names.push(...st.exportClause.elements.map(e=>e.name.text));continue;}
    if(!exported)continue;
    if(ts.isVariableStatement(st))names.push(...st.declarationList.declarations.map(d=>ts.isIdentifier(d.name)?d.name.text:"").filter(Boolean));
    else if(st.name&&ts.isIdentifier(st.name))names.push(st.name.text);
  }
  return [...new Set(names)];
}

/* Every import, export-from, dynamic import() and require() in a file, with whether it is type-only. */
function importsOf(file,text){
  const kind=file.endsWith("x")?ts.ScriptKind.TSX:ts.ScriptKind.TS;
  const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,kind);
  about.set(file,{...purposeOf(sf,text),x:exportsOf(sf)});
  const found=[];
  const visit=node=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const clause=node.importClause;
      const typeOnly=!!clause&&(clause.isTypeOnly||(!clause.name&&!!clause.namedBindings&&ts.isNamedImports(clause.namedBindings)&&clause.namedBindings.elements.length>0&&clause.namedBindings.elements.every(e=>e.isTypeOnly)));
      found.push({spec:node.moduleSpecifier.text,typeOnly});
    }else if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
      found.push({spec:node.moduleSpecifier.text,typeOnly:node.isTypeOnly});
    }else if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==="require"))){
      found.push({spec:node.arguments[0].text,typeOnly:false,lazy:node.expression.kind===ts.SyntaxKind.ImportKeyword});
    }else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal)){
      found.push({spec:node.argument.literal.text,typeOnly:true});
    }
    ts.forEachChild(node,visit);
  };
  visit(sf);
  return found;
}

const about=new Map(); // file -> {d: what it is about, x: exported names}
const files=new Map();
const ensure=path=>{if(!files.has(path)){const text=existsSync(join(root,path))?readFileSync(join(root,path),"utf8"):"";files.set(path,{path,area:areaOf(path),lines:text?text.split("\n").length:0,kind:path.split(".").pop(),packages:new Set()});}return files.get(path);};
const edges=new Map(); // "from\0to" -> {from,to,typeOnly,lazy}
for(const file of sources){
  const node=ensure(file),text=readFileSync(join(root,file),"utf8");
  for(const {spec,typeOnly,lazy} of importsOf(file,text)){
    const target=resolveImport(file,spec);
    if(!target){if(!spec.startsWith("."))node.packages.add(packageOf(spec));continue;}
    ensure(target);
    const key=`${file}\0${target}`,old=edges.get(key);
    /* One runtime import of a file makes the pair a runtime edge. */
    if(!old)edges.set(key,{from:file,to:target,typeOnly:!!typeOnly,lazy:!!lazy});
    else{old.typeOnly=old.typeOnly&&!!typeOnly;old.lazy=old.lazy&&!!lazy;}
  }
}

const list=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
const index=new Map(list.map((f,i)=>[f.path,i]));
const links=[...edges.values()].map(e=>({s:index.get(e.from),t:index.get(e.to),type:e.typeOnly?1:0,lazy:e.lazy?1:0}));

/* Cycles: strongly connected components over runtime edges (type-only imports vanish at build time). */
const out1=list.map(()=>[]);
for(const l of links)if(!l.type)out1[l.s].push(l.t);
let counter=0;const idx=new Array(list.length).fill(-1),low=new Array(list.length).fill(0),onStack=new Array(list.length).fill(false),stack=[],sccs=[];
for(let start=0;start<list.length;start++){
  if(idx[start]!==-1)continue;
  const work=[[start,0]];idx[start]=low[start]=counter++;stack.push(start);onStack[start]=true;
  while(work.length){
    const frame=work[work.length-1],[v]=frame;
    if(frame[1]<out1[v].length){
      const w=out1[v][frame[1]++];
      if(idx[w]===-1){idx[w]=low[w]=counter++;stack.push(w);onStack[w]=true;work.push([w,0]);}
      else if(onStack[w])low[v]=Math.min(low[v],idx[w]);
    }else{
      work.pop();
      if(work.length)low[work[work.length-1][0]]=Math.min(low[work[work.length-1][0]],low[v]);
      if(low[v]===idx[v]){const comp=[];let w;do{w=stack.pop();onStack[w]=false;comp.push(w);}while(w!==v);if(comp.length>1)sccs.push(comp.sort((a,b)=>a-b));}
    }
  }
}
sccs.sort((a,b)=>b.length-a.length);

const data={
  generated:new Date().toISOString(),
  roots:ROOTS,
  files:list.map(f=>({p:f.path,a:f.area,l:f.lines,k:f.kind,pk:[...f.packages].sort(),d:about.get(f.path)?.d??"",ds:about.get(f.path)?.src??"",of:about.get(f.path)?.of??"",x:about.get(f.path)?.x??[]})),
  areas:areaReadmes(),
  links,
  cycles:sccs,
};

/* An area explains itself through a README.md in its folder (first paragraph), when it has one. */
function areaReadmes(){
  const result={};
  for(const area of new Set(list.map(f=>f.area))){
    const readme=join(root,area,"README.md");if(!existsSync(readme))continue;
    const para=readFileSync(readme,"utf8").split(/\n\s*\n/).map(p=>p.trim()).find(p=>p&&!p.startsWith("#")&&!p.startsWith("<"));
    if(para)result[area]=sentences(para.replace(/\s+/g," ").replace(/[*`_]/g,""),400);
  }
  return result;
}
const described=list.filter(f=>about.get(f.path)?.src==="file").length,byExport=list.filter(f=>about.get(f.path)?.src==="export").length;
const template=readFileSync(join(root,"scripts/code-map.template.html"),"utf8");
const html=template.replace("/*__DATA__*/null",JSON.stringify(data).replace(/</g,"\\u003c"));
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,html);
const runtime=links.filter(l=>!l.type).length;
console.log(`code map: ${list.length} files (${described} explain themselves, ${byExport} through their first export), ${links.length} imports (${runtime} runtime), ${sccs.length} cycles -> ${posix(relative(root,out))}`);
