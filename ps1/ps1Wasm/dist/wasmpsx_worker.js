var Module=typeof Module!="undefined"?Module:{};var ENVIRONMENT_IS_WEB=!!globalThis.window;var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";if(!Module["expectedDataFileDownloads"])Module["expectedDataFileDownloads"]=0;Module["expectedDataFileDownloads"]++;(()=>{var isPthread=typeof ENVIRONMENT_IS_PTHREAD!="undefined"&&ENVIRONMENT_IS_PTHREAD;var isWasmWorker=typeof ENVIRONMENT_IS_WASM_WORKER!="undefined"&&ENVIRONMENT_IS_WASM_WORKER;if(isPthread||isWasmWorker)return;var isNode=globalThis.process&&globalThis.process.versions&&globalThis.process.versions.node&&globalThis.process.type!="renderer";async function loadPackage(metadata){var PACKAGE_PATH="";if(typeof window==="object"){PACKAGE_PATH=window["encodeURIComponent"](window.location.pathname.substring(0,window.location.pathname.lastIndexOf("/"))+"/")}else if(typeof process==="undefined"&&typeof location!=="undefined"){PACKAGE_PATH=encodeURIComponent(location.pathname.substring(0,location.pathname.lastIndexOf("/"))+"/")}var PACKAGE_NAME="wasmpsx_worker.data";var REMOTE_PACKAGE_BASE="wasmpsx_worker.data";var REMOTE_PACKAGE_NAME=Module["locateFile"]?Module["locateFile"](REMOTE_PACKAGE_BASE,""):REMOTE_PACKAGE_BASE;var REMOTE_PACKAGE_SIZE=metadata["remote_package_size"];async function fetchRemotePackage(packageName,packageSize){if(isNode){var contents=require("fs").readFileSync(packageName);return new Uint8Array(contents).buffer}if(!Module["dataFileDownloads"])Module["dataFileDownloads"]={};try{var response=await fetch(packageName)}catch(e){throw new Error(`Network Error: ${packageName}`,{e})}if(!response.ok){throw new Error(`${response.status}: ${response.url}`)}const chunks=[];const headers=response.headers;const total=Number(headers.get("Content-Length")||packageSize);let loaded=0;Module["setStatus"]&&Module["setStatus"]("Downloading data...");const reader=response.body.getReader();while(1){var{done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.length;Module["dataFileDownloads"][packageName]={loaded,total};let totalLoaded=0;let totalSize=0;for(const download of Object.values(Module["dataFileDownloads"])){totalLoaded+=download.loaded;totalSize+=download.total}Module["setStatus"]&&Module["setStatus"](`Downloading data... (${totalLoaded}/${totalSize})`)}const packageData=new Uint8Array(chunks.map(c=>c.length).reduce((a,b)=>a+b,0));let offset=0;for(const chunk of chunks){packageData.set(chunk,offset);offset+=chunk.length}return packageData.buffer}var fetchPromise;var fetched=Module["getPreloadedPackage"]&&Module["getPreloadedPackage"](REMOTE_PACKAGE_NAME,REMOTE_PACKAGE_SIZE);if(!fetched){fetchPromise=fetchRemotePackage(REMOTE_PACKAGE_NAME,REMOTE_PACKAGE_SIZE)}async function runWithFS(Module){function assert(check,msg){if(!check)throw new Error(msg)}Module["FS_createPath"]("/","bios",true,true);async function processPackageData(arrayBuffer){assert(arrayBuffer,"Loading data file failed.");assert(arrayBuffer.constructor.name===ArrayBuffer.name,"bad input to processPackageData "+arrayBuffer.constructor.name);var byteArray=new Uint8Array(arrayBuffer);for(var file of metadata["files"]){var name=file["filename"];var data=byteArray.subarray(file["start"],file["end"]);Module["FS_createDataFile"](name,null,data,true,true,true)}Module["removeRunDependency"]("datafile_wasmpsx_worker.data")}Module["addRunDependency"]("datafile_wasmpsx_worker.data");if(!Module["preloadResults"])Module["preloadResults"]={};Module["preloadResults"][PACKAGE_NAME]={fromCache:false};if(!fetched){fetched=await fetchPromise}await processPackageData(fetched)}if(Module["FS_createPath"]){runWithFS(Module)}else{if(!Module["preRun"])Module["preRun"]=[];Module["preRun"].push(runWithFS)}}loadPackage({files:[{filename:"/bios/ps-41a.bin",start:0,end:524288}],remote_package_size:524288})})();Module["locateFile"]=function(path,prefix){var v="";try{var m=/[?&]v=([^&]*)/.exec(String(self.location.search));if(m)v=m[1]}catch(e){}return(prefix||"")+path+(v&&/\.(wasm|data)$/.test(path)?"?v="+v:"")};var programArgs=[];var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};var _scriptName=globalThis.document?.currentScript?.src;if(typeof __filename!="undefined"){_scriptName=__filename}else if(ENVIRONMENT_IS_WORKER){_scriptName=self.location.href}var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var readAsync,readBinary;if(ENVIRONMENT_IS_NODE){var fs=require("node:fs");scriptDirectory=__dirname+"/";readBinary=filename=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename);return ret};readAsync=async(filename,binary=true)=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename,binary?undefined:"utf8");return ret};if(process.argv.length>1){thisProgram=process.argv[1].replace(/\\/g,"/")}programArgs=process.argv.slice(2);if(typeof module!="undefined"){module["exports"]=Module}quit_=(status,toThrow)=>{process.exitCode=status;throw toThrow}}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){try{scriptDirectory=new URL(".",_scriptName).href}catch{}{if(ENVIRONMENT_IS_WORKER){readBinary=url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)}}readAsync=async url=>{if(isFileURI(url)){return new Promise((resolve,reject)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=()=>{if(xhr.status==200||xhr.status==0&&xhr.response){resolve(xhr.response);return}reject(xhr.status)};xhr.onerror=reject;xhr.send(null)})}var response=await fetch(url,{credentials:"same-origin"});if(response.ok){return response.arrayBuffer()}throw new Error(response.status+" : "+response.url)}}}else{}var out=console.log.bind(console);var err=console.error.bind(console);var wasmBinary;var ABORT=false;var EXITSTATUS;var isFileURI=filename=>filename.startsWith("file://");class EmscriptenEH{}class EmscriptenSjLj extends EmscriptenEH{}var runtimeInitialized=false;function getMemoryBuffer(){try{var b=wasmMemory.toResizableBuffer();return b}catch{}return wasmMemory.buffer}function updateMemoryViews(){if(HEAP8?.buffer?.resizable)return;var b=getMemoryBuffer();HEAP8=new Int8Array(b);HEAP16=new Int16Array(b);Module["HEAPU8"]=HEAPU8=new Uint8Array(b);HEAPU16=new Uint16Array(b);Module["HEAP32"]=HEAP32=new Int32Array(b);Module["HEAPU32"]=HEAPU32=new Uint32Array(b);HEAPF32=new Float32Array(b);HEAPF64=new Float64Array(b);HEAP64=new BigInt64Array(b);HEAPU64=new BigUint64Array(b)}function preRun(){var preRun=Module["preRun"];if(preRun){if(typeof preRun=="function")preRun=[preRun];onPreRuns.push(...preRun)}callRuntimeCallbacks(onPreRuns)}function initRuntime(){runtimeInitialized=true;if(!Module["noFSInit"]&&!FS.initialized)FS.init();TTY.init();wasmExports["x"]();FS.ignorePermissions=false}function postRun(){var postRun=Module["postRun"];if(postRun){if(typeof postRun=="function")postRun=[postRun];onPostRuns.push(...postRun)}callRuntimeCallbacks(onPostRuns)}function abort(what){Module["onAbort"]?.(what);what=`Aborted(${what})`;err(what);ABORT=true;what+=". Build with -sASSERTIONS for more info.";var e=new WebAssembly.RuntimeError(what);throw e}var wasmBinaryFile;function findWasmBinary(){return locateFile("wasmpsx_worker.wasm")}function getBinarySync(file){if(readBinary){return readBinary(file)}throw"both async and sync fetching of the wasm failed"}async function getWasmBinary(binaryFile){if(!wasmBinary){try{var response=await readAsync(binaryFile);return new Uint8Array(response)}catch{}}return getBinarySync(binaryFile)}async function instantiateArrayBuffer(binaryFile,imports){try{var binary=await getWasmBinary(binaryFile);var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){err(`failed to asynchronously prepare wasm: ${reason}`);abort(reason)}}async function instantiateAsync(binary,binaryFile,imports){if(!binary&&!isFileURI(binaryFile)&&!ENVIRONMENT_IS_NODE){try{var response=fetch(binaryFile,{credentials:"same-origin"});var instantiationResult=await WebAssembly.instantiateStreaming(response,imports);return instantiationResult}catch(reason){err(`wasm streaming compile failed: ${reason}`);err("falling back to ArrayBuffer instantiation")}}return instantiateArrayBuffer(binaryFile,imports)}function getWasmImports(){var imports={a:wasmImports};return imports}async function createWasm(){function receiveInstance(instance){wasmExports=instance.exports;assignWasmExports(wasmExports);updateMemoryViews();return wasmExports}function receiveInstantiationResult(result){return receiveInstance(result["instance"])}var info=getWasmImports();var instantiateWasm=Module["instantiateWasm"];if(instantiateWasm){return new Promise(resolve=>{instantiateWasm(info,inst=>resolve(receiveInstance(inst)))})}wasmBinaryFile??=findWasmBinary();var result=await instantiateAsync(wasmBinary,wasmBinaryFile,info);var exports=receiveInstantiationResult(result);return exports}class ExitStatus{name="ExitStatus";constructor(status){this.message=`Program terminated with exit(${status})`;this.status=status}}var HEAP16;var HEAP32;var HEAP64;var HEAP8;var HEAPF32;var HEAPF64;var HEAPU16;var HEAPU32;var HEAPU64;var HEAPU8;var callRuntimeCallbacks=callbacks=>{while(callbacks.length>0){callbacks.shift()(Module)}};var onPostRuns=[];var onPreRuns=[];function getValue(ptr,type="i8"){if(type.endsWith("*"))type="*";switch(type){case"i1":return HEAP8[ptr];case"i8":return HEAP8[ptr];case"i16":return HEAP16[ptr>>1];case"i32":return HEAP32[ptr>>2];case"i64":return HEAP64[ptr>>3];case"float":return HEAPF32[ptr>>2];case"double":return HEAPF64[ptr>>3];case"*":return HEAPU32[ptr>>2];default:abort(`invalid type for getValue: ${type}`)}}var noExitRuntime=true;function setValue(ptr,value,type="i8"){if(type.endsWith("*"))type="*";switch(type){case"i1":HEAP8[ptr]=value;break;case"i8":HEAP8[ptr]=value;break;case"i16":HEAP16[ptr>>1]=value;break;case"i32":HEAP32[ptr>>2]=value;break;case"i64":HEAP64[ptr>>3]=BigInt(value);break;case"float":HEAPF32[ptr>>2]=value;break;case"double":HEAPF64[ptr>>3]=value;break;case"*":HEAPU32[ptr>>2]=value;break;default:abort(`invalid type for setValue: ${type}`)}}var stackRestore=val=>__emscripten_stack_restore(val);var stackSave=()=>_emscripten_stack_get_current();var syscallGetVarargI=()=>{var ret=HEAP32[+SYSCALLS.varargs>>2];SYSCALLS.varargs+=4;return ret};var syscallGetVarargP=syscallGetVarargI;var PATH={isAbs:path=>path.charAt(0)==="/",splitPath:filename=>{var splitPathRe=/^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;return splitPathRe.exec(filename).slice(1)},normalizeArray:(parts,allowAboveRoot)=>{var up=0;for(var i=parts.length-1;i>=0;i--){var last=parts[i];if(last==="."){parts.splice(i,1)}else if(last===".."){parts.splice(i,1);up++}else if(up){parts.splice(i,1);up--}}if(allowAboveRoot){for(;up;up--){parts.unshift("..")}}return parts},normalize:path=>{var isAbsolute=PATH.isAbs(path),trailingSlash=path.slice(-1)==="/";path=PATH.normalizeArray(path.split("/").filter(p=>!!p),!isAbsolute).join("/");if(!path&&!isAbsolute){path="."}if(path&&trailingSlash){path+="/"}return(isAbsolute?"/":"")+path},dirname:path=>{var result=PATH.splitPath(path),root=result[0],dir=result[1];if(!root&&!dir){return"."}if(dir){dir=dir.slice(0,-1)}return root+dir},basename:path=>path&&path.match(/([^\/]+|\/)\/*$/)[1],join:(...paths)=>PATH.normalize(paths.join("/")),join2:(l,r)=>PATH.normalize(l+"/"+r)};var initRandomFill=()=>{if(ENVIRONMENT_IS_NODE){var nodeCrypto=require("node:crypto");return view=>(nodeCrypto.randomFillSync(view),0)}return view=>(crypto.getRandomValues(view),0)};var randomFill=view=>(randomFill=initRandomFill())(view);var PATH_FS={resolve:(...args)=>{var resolvedPath="",resolvedAbsolute=false;for(var i=args.length-1;i>=-1&&!resolvedAbsolute;i--){var path=i>=0?args[i]:FS.cwd();if(typeof path!="string"){throw new TypeError("Arguments to path.resolve must be strings")}else if(!path){return""}resolvedPath=path+"/"+resolvedPath;resolvedAbsolute=PATH.isAbs(path)}resolvedPath=PATH.normalizeArray(resolvedPath.split("/").filter(p=>!!p),!resolvedAbsolute).join("/");return(resolvedAbsolute?"/":"")+resolvedPath||"."},relative:(from,to)=>{from=PATH_FS.resolve(from).slice(1);to=PATH_FS.resolve(to).slice(1);function trim(arr){var start=0;for(;start<arr.length;start++){if(arr[start]!=="")break}var end=arr.length-1;for(;end>=0;end--){if(arr[end]!=="")break}if(start>end)return[];return arr.slice(start,end-start+1)}var fromParts=trim(from.split("/"));var toParts=trim(to.split("/"));var length=Math.min(fromParts.length,toParts.length);var samePartsLength=length;for(var i=0;i<length;i++){if(fromParts[i]!==toParts[i]){samePartsLength=i;break}}var outputParts=[];for(var i=samePartsLength;i<fromParts.length;i++){outputParts.push("..")}outputParts=outputParts.concat(toParts.slice(samePartsLength));return outputParts.join("/")}};var UTF8Decoder=globalThis.TextDecoder&&new TextDecoder;var findStringEnd=(heapOrArray,idx,maxBytesToRead,ignoreNul)=>{var maxIdx=idx+maxBytesToRead;if(ignoreNul)return maxIdx;while(heapOrArray[idx]&&!(idx>=maxIdx))++idx;return idx};var UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead,ignoreNul)=>{var endPtr=findStringEnd(heapOrArray,idx,maxBytesToRead,ignoreNul);if(endPtr-idx>16&&heapOrArray.buffer&&UTF8Decoder){return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))}var str="";while(idx<endPtr){var u0=heapOrArray[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heapOrArray[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heapOrArray[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2}else{u0=(u0&7)<<18|u1<<12|u2<<6|heapOrArray[idx++]&63}if(u0<65536){str+=String.fromCharCode(u0)}else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}return str};var FS_stdin_getChar_buffer=[];var lengthBytesUTF8=str=>{var len=0;for(var i=0;i<str.length;++i){var c=str.charCodeAt(i);if(c<=127){len++}else if(c<=2047){len+=2}else if(c>=55296&&c<=57343){len+=4;++i}else{len+=3}}return len};var stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.codePointAt(i);if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63}else{if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;i++}}heap[outIdx]=0;return outIdx-startIdx};var intArrayFromString=(stringy,dontAddNull,length)=>{var len=length>0?length:lengthBytesUTF8(stringy)+1;var u8array=new Array(len);var numBytesWritten=stringToUTF8Array(stringy,u8array,0,u8array.length);if(dontAddNull)u8array.length=numBytesWritten;return u8array};var FS_stdin_getChar=()=>{if(!FS_stdin_getChar_buffer.length){var result=null;if(ENVIRONMENT_IS_NODE){var BUFSIZE=256;var buf=Buffer.alloc(BUFSIZE);var bytesRead=0;var fd=process.stdin.fd;try{bytesRead=fs.readSync(fd,buf,0,BUFSIZE)}catch(e){if(e.toString().includes("EOF"))bytesRead=0;else throw e}if(bytesRead>0){result=buf.slice(0,bytesRead).toString("utf-8")}}else if(globalThis.window?.prompt){result=window.prompt("Input: ");if(result!==null){result+="\n"}}else{}if(!result){return null}FS_stdin_getChar_buffer=intArrayFromString(result,true)}return FS_stdin_getChar_buffer.shift()};var TTY={ttys:[],init(){},shutdown(){},register(dev,ops){TTY.ttys[dev]={input:[],output:[],ops};FS.registerDevice(dev,TTY.stream_ops)},stream_ops:{open(stream){var tty=TTY.ttys[stream.node.rdev];if(!tty){throw new FS.ErrnoError(43)}stream.tty=tty;stream.seekable=false},close(stream){stream.tty.ops.fsync(stream.tty)},fsync(stream){stream.tty.ops.fsync(stream.tty)},read(stream,buffer,offset,length,pos){if(!stream.tty||!stream.tty.ops.get_char){throw new FS.ErrnoError(60)}var bytesRead=0;for(var i=0;i<length;i++){var result;try{result=stream.tty.ops.get_char(stream.tty)}catch(e){throw new FS.ErrnoError(29)}if(result===undefined&&bytesRead===0){throw new FS.ErrnoError(6)}if(result===null||result===undefined)break;bytesRead++;buffer[offset+i]=result}if(bytesRead){stream.node.atime=Date.now()}return bytesRead},write(stream,buffer,offset,length,pos){if(!stream.tty||!stream.tty.ops.put_char){throw new FS.ErrnoError(60)}try{for(var i=0;i<length;i++){stream.tty.ops.put_char(stream.tty,buffer[offset+i])}}catch(e){throw new FS.ErrnoError(29)}if(length){stream.node.mtime=stream.node.ctime=Date.now()}return i}},default_tty_ops:{get_char(tty){return FS_stdin_getChar()},put_char(tty,val){if(val===null||val===10){out(UTF8ArrayToString(tty.output));tty.output=[]}else{if(val!=0)tty.output.push(val)}},fsync(tty){if(tty.output?.length>0){out(UTF8ArrayToString(tty.output));tty.output=[]}},ioctl_tcgets(tty){return{c_iflag:25856,c_oflag:5,c_cflag:191,c_lflag:35387,c_cc:[3,28,127,21,4,0,1,0,17,19,26,0,18,15,23,22,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}},ioctl_tcsets(tty,optional_actions,data){return 0},ioctl_tiocgwinsz(tty){return[24,80]}},default_tty1_ops:{put_char(tty,val){if(val===null||val===10){err(UTF8ArrayToString(tty.output));tty.output=[]}else{if(val!=0)tty.output.push(val)}},fsync(tty){if(tty.output?.length>0){err(UTF8ArrayToString(tty.output));tty.output=[]}}}};var zeroMemory=(ptr,size)=>HEAPU8.fill(0,ptr,ptr+size);var alignMemory=(size,alignment)=>Math.ceil(size/alignment)*alignment;var mmapAlloc=size=>{size=alignMemory(size,65536);var ptr=_emscripten_builtin_memalign(65536,size);if(ptr)zeroMemory(ptr,size);return ptr};var MEMFS={ops_table:null,mount(mount){return MEMFS.createNode(null,"/",16895,0)},createNode(parent,name,mode,dev){if(FS.isBlkdev(mode)||FS.isFIFO(mode)){throw new FS.ErrnoError(63)}MEMFS.ops_table||={dir:{node:{getattr:MEMFS.node_ops.getattr,setattr:MEMFS.node_ops.setattr,lookup:MEMFS.node_ops.lookup,mknod:MEMFS.node_ops.mknod,rename:MEMFS.node_ops.rename,unlink:MEMFS.node_ops.unlink,rmdir:MEMFS.node_ops.rmdir,readdir:MEMFS.node_ops.readdir,symlink:MEMFS.node_ops.symlink},stream:{llseek:MEMFS.stream_ops.llseek}},file:{node:{getattr:MEMFS.node_ops.getattr,setattr:MEMFS.node_ops.setattr},stream:{llseek:MEMFS.stream_ops.llseek,read:MEMFS.stream_ops.read,write:MEMFS.stream_ops.write,mmap:MEMFS.stream_ops.mmap,msync:MEMFS.stream_ops.msync}},link:{node:{getattr:MEMFS.node_ops.getattr,setattr:MEMFS.node_ops.setattr,readlink:MEMFS.node_ops.readlink},stream:{}},chrdev:{node:{getattr:MEMFS.node_ops.getattr,setattr:MEMFS.node_ops.setattr},stream:FS.chrdev_stream_ops}};var node=FS.createNode(parent,name,mode,dev);if(FS.isDir(node.mode)){node.node_ops=MEMFS.ops_table.dir.node;node.stream_ops=MEMFS.ops_table.dir.stream;node.contents={}}else if(FS.isFile(node.mode)){node.node_ops=MEMFS.ops_table.file.node;node.stream_ops=MEMFS.ops_table.file.stream;node.usedBytes=0;node.contents=MEMFS.emptyFileContents??=new Uint8Array(0)}else if(FS.isLink(node.mode)){node.node_ops=MEMFS.ops_table.link.node;node.stream_ops=MEMFS.ops_table.link.stream}else if(FS.isChrdev(node.mode)){node.node_ops=MEMFS.ops_table.chrdev.node;node.stream_ops=MEMFS.ops_table.chrdev.stream}node.atime=node.mtime=node.ctime=Date.now();if(parent){parent.contents[name]=node;parent.atime=parent.mtime=parent.ctime=node.atime}return node},getFileDataAsTypedArray(node){return node.contents.subarray(0,node.usedBytes)},expandFileStorage(node,newCapacity){var prevCapacity=node.contents.length;if(prevCapacity>=newCapacity)return;var CAPACITY_DOUBLING_MAX=1024*1024;newCapacity=Math.max(newCapacity,prevCapacity*(prevCapacity<CAPACITY_DOUBLING_MAX?2:1.125)>>>0);if(prevCapacity)newCapacity=Math.max(newCapacity,256);var oldContents=MEMFS.getFileDataAsTypedArray(node);node.contents=new Uint8Array(newCapacity);node.contents.set(oldContents)},resizeFileStorage(node,newSize){if(node.usedBytes==newSize)return;var oldContents=node.contents;node.contents=new Uint8Array(newSize);node.contents.set(oldContents.subarray(0,Math.min(newSize,node.usedBytes)));node.usedBytes=newSize},node_ops:{getattr(node){var attr={};attr.dev=FS.isChrdev(node.mode)?node.id:1;attr.ino=node.id;attr.mode=node.mode;attr.nlink=1;attr.uid=0;attr.gid=0;attr.rdev=node.rdev;if(FS.isDir(node.mode)){attr.size=4096}else if(FS.isFile(node.mode)){attr.size=node.usedBytes}else if(FS.isLink(node.mode)){attr.size=node.link.length}else{attr.size=0}attr.atime=new Date(node.atime);attr.mtime=new Date(node.mtime);attr.ctime=new Date(node.ctime);attr.blksize=4096;attr.blocks=Math.ceil(attr.size/attr.blksize);return attr},setattr(node,attr){for(const key of["mode","atime","mtime","ctime"]){if(attr[key]!=null){node[key]=attr[key]}}if(attr.size!==undefined){MEMFS.resizeFileStorage(node,attr.size)}},lookup(parent,name){if(!MEMFS.doesNotExistError){MEMFS.doesNotExistError=new FS.ErrnoError(44);MEMFS.doesNotExistError.stack="<generic error, no stack>"}throw MEMFS.doesNotExistError},mknod(parent,name,mode,dev){return MEMFS.createNode(parent,name,mode,dev)},rename(old_node,new_dir,new_name){var new_node;try{new_node=FS.lookupNode(new_dir,new_name)}catch(e){}if(new_node){if(FS.isDir(old_node.mode)){for(var i in new_node.contents){throw new FS.ErrnoError(55)}}FS.hashRemoveNode(new_node)}delete old_node.parent.contents[old_node.name];new_dir.contents[new_name]=old_node;old_node.name=new_name;new_dir.ctime=new_dir.mtime=old_node.parent.ctime=old_node.parent.mtime=Date.now()},unlink(parent,name){delete parent.contents[name];parent.ctime=parent.mtime=Date.now()},rmdir(parent,name){var node=FS.lookupNode(parent,name);for(var i in node.contents){throw new FS.ErrnoError(55)}delete parent.contents[name];parent.ctime=parent.mtime=Date.now()},readdir(node){return[".","..",...Object.keys(node.contents)]},symlink(parent,newname,oldpath){var node=MEMFS.createNode(parent,newname,511|40960,0);node.link=oldpath;return node},readlink(node){if(!FS.isLink(node.mode)){throw new FS.ErrnoError(28)}return node.link}},stream_ops:{read(stream,buffer,offset,length,position){var contents=stream.node.contents;if(position>=stream.node.usedBytes)return 0;var size=Math.min(stream.node.usedBytes-position,length);buffer.set(contents.subarray(position,position+size),offset);return size},write(stream,buffer,offset,length,position,canOwn){if(buffer.buffer===HEAP8.buffer){canOwn=false}if(!length)return 0;var node=stream.node;node.mtime=node.ctime=Date.now();if(canOwn){node.contents=buffer.subarray(offset,offset+length);node.usedBytes=length}else if(node.usedBytes===0&&position===0){node.contents=buffer.slice(offset,offset+length);node.usedBytes=length}else{MEMFS.expandFileStorage(node,position+length);node.contents.set(buffer.subarray(offset,offset+length),position);node.usedBytes=Math.max(node.usedBytes,position+length)}return length},llseek(stream,offset,whence){var position=offset;if(whence===1){position+=stream.position}else if(whence===2){if(FS.isFile(stream.node.mode)){position+=stream.node.usedBytes}}if(position<0){throw new FS.ErrnoError(28)}return position},mmap(stream,length,position,prot,flags){if(!FS.isFile(stream.node.mode)){throw new FS.ErrnoError(43)}var ptr;var allocated;var contents=stream.node.contents;if(!(flags&2)&&contents.buffer===HEAP8.buffer){allocated=false;ptr=contents.byteOffset}else{allocated=true;ptr=mmapAlloc(length);if(!ptr){throw new FS.ErrnoError(48)}if(contents){if(position>0||position+length<contents.length){if(contents.subarray){contents=contents.subarray(position,position+length)}else{contents=Array.prototype.slice.call(contents,position,position+length)}}HEAP8.set(contents,ptr)}}return{ptr,allocated}},msync(stream,buffer,offset,length,mmapFlags){MEMFS.stream_ops.write(stream,buffer,0,length,offset,false);return 0}}};var FS_modeStringToFlags=str=>{if(typeof str!="string")return str;var flagModes={r:0,"r+":2,w:512|64|1,"w+":512|64|2,a:1024|64|1,"a+":1024|64|2};var flags=flagModes[str];if(typeof flags=="undefined"){throw new Error(`Unknown file open mode: ${str}`)}return flags};var FS_fileDataToTypedArray=data=>{if(typeof data=="string"){data=intArrayFromString(data,true)}if(!data.subarray){data=new Uint8Array(data)}return data};var FS_getMode=(canRead,canWrite)=>{var mode=0;if(canRead)mode|=292|73;if(canWrite)mode|=146;return mode};var asyncLoad=async url=>{var arrayBuffer=await readAsync(url);return new Uint8Array(arrayBuffer)};var FS_createDataFile=(...args)=>FS.createDataFile(...args);var getUniqueRunDependency=id=>id;var dependenciesPromise=null;var resolveRunDependencies=async()=>dependenciesPromise;var runDependencies=0;var removeRunDependency=id=>{runDependencies--;Module["monitorRunDependencies"]?.(runDependencies);if(!runDependencies){dependenciesPromise.resolve()}};var addRunDependency=id=>{if(!runDependencies){var resolve;dependenciesPromise=new Promise(r=>resolve=r);dependenciesPromise.resolve=resolve}runDependencies++;Module["monitorRunDependencies"]?.(runDependencies)};var preloadPlugins=[];var FS_handledByPreloadPlugin=async(byteArray,fullname)=>{if(typeof Browser!="undefined")Browser.init();for(var plugin of preloadPlugins){if(plugin["canHandle"](fullname)){return plugin["handle"](byteArray,fullname)}}return byteArray};var FS_preloadFile=async(parent,name,url,canRead,canWrite,dontCreateFile,canOwn,preFinish)=>{var fullname=name?PATH_FS.resolve(PATH.join2(parent,name)):parent;var dep=getUniqueRunDependency(`cp ${fullname}`);addRunDependency(dep);try{var byteArray=url;if(typeof url=="string"){byteArray=await asyncLoad(url)}byteArray=await FS_handledByPreloadPlugin(byteArray,fullname);preFinish?.();if(!dontCreateFile){FS_createDataFile(parent,name,byteArray,canRead,canWrite,canOwn)}}finally{removeRunDependency(dep)}};var FS_createPreloadedFile=(parent,name,url,canRead,canWrite,onload,onerror,dontCreateFile,canOwn,preFinish)=>{FS_preloadFile(parent,name,url,canRead,canWrite,dontCreateFile,canOwn,preFinish).then(onload).catch(onerror)};var FS={root:null,mounts:[],devices:{},streams:[],nextInode:1,nameTable:null,currentPath:"/",initialized:false,ignorePermissions:true,filesystems:null,syncFSRequests:0,ErrnoError:class{name="ErrnoError";constructor(errno){this.errno=errno}},FSStream:class{shared={};get object(){return this.node}set object(val){this.node=val}get isRead(){return(this.flags&2097155)!==1}get isWrite(){return(this.flags&2097155)!==0}get isAppend(){return this.flags&1024}get flags(){return this.shared.flags}set flags(val){this.shared.flags=val}get position(){return this.shared.position}set position(val){this.shared.position=val}},FSNode:class{node_ops={};stream_ops={};readMode=292|73;writeMode=146;mounted=null;constructor(parent,name,mode,rdev){if(!parent){parent=this}this.parent=parent;this.mount=parent.mount;this.id=FS.nextInode++;this.name=name;this.mode=mode;this.rdev=rdev;this.atime=this.mtime=this.ctime=Date.now()}get read(){return(this.mode&this.readMode)===this.readMode}set read(val){val?this.mode|=this.readMode:this.mode&=~this.readMode}get write(){return(this.mode&this.writeMode)===this.writeMode}set write(val){val?this.mode|=this.writeMode:this.mode&=~this.writeMode}get isFolder(){return FS.isDir(this.mode)}get isDevice(){return FS.isChrdev(this.mode)}},lookupPath(path,opts={}){if(!path){throw new FS.ErrnoError(44)}opts.follow_mount??=true;if(!PATH.isAbs(path)){path=FS.cwd()+"/"+path}linkloop:for(var nlinks=0;nlinks<40;nlinks++){var parts=path.split("/").filter(p=>!!p);var current=FS.root;var current_path="/";for(var i=0;i<parts.length;i++){var islast=i===parts.length-1;if(islast&&opts.parent){break}if(parts[i]==="."){continue}if(parts[i]===".."){current_path=PATH.dirname(current_path);if(FS.isRoot(current)){path=current_path+"/"+parts.slice(i+1).join("/");nlinks--;continue linkloop}else{current=current.parent}continue}current_path=PATH.join2(current_path,parts[i]);try{current=FS.lookupNode(current,parts[i])}catch(e){if(e?.errno===44&&islast&&opts.noent_okay){return{path:current_path}}throw e}if(FS.isMountpoint(current)&&(!islast||opts.follow_mount)){current=current.mounted.root}if(FS.isLink(current.mode)&&(!islast||opts.follow)){if(!current.node_ops.readlink){throw new FS.ErrnoError(52)}var link=current.node_ops.readlink(current);if(!PATH.isAbs(link)){link=PATH.dirname(current_path)+"/"+link}path=link+"/"+parts.slice(i+1).join("/");continue linkloop}}return{path:current_path,node:current}}throw new FS.ErrnoError(32)},getPath(node){var path;while(true){if(FS.isRoot(node)){var mount=node.mount.mountpoint;if(!path)return mount;return mount[mount.length-1]!=="/"?`${mount}/${path}`:mount+path}path=path?`${node.name}/${path}`:node.name;node=node.parent}},hashName(parentid,name){var hash=0;for(var i=0;i<name.length;i++){hash=(hash<<5)-hash+name.charCodeAt(i)|0}return(parentid+hash>>>0)%FS.nameTable.length},hashAddNode(node){var hash=FS.hashName(node.parent.id,node.name);node.name_next=FS.nameTable[hash];FS.nameTable[hash]=node},hashRemoveNode(node){var hash=FS.hashName(node.parent.id,node.name);if(FS.nameTable[hash]===node){FS.nameTable[hash]=node.name_next}else{var current=FS.nameTable[hash];while(current){if(current.name_next===node){current.name_next=node.name_next;break}current=current.name_next}}},lookupNode(parent,name){var errCode=FS.mayLookup(parent);if(errCode){throw new FS.ErrnoError(errCode)}var hash=FS.hashName(parent.id,name);for(var node=FS.nameTable[hash];node;node=node.name_next){var nodeName=node.name;if(node.parent.id===parent.id&&nodeName===name){return node}}return FS.lookup(parent,name)},createNode(parent,name,mode,rdev){var node=new FS.FSNode(parent,name,mode,rdev);FS.hashAddNode(node);return node},destroyNode(node){FS.hashRemoveNode(node)},isRoot(node){return node===node.parent},isMountpoint(node){return!!node.mounted},isFile(mode){return(mode&61440)===32768},isDir(mode){return(mode&61440)===16384},isLink(mode){return(mode&61440)===40960},isChrdev(mode){return(mode&61440)===8192},isBlkdev(mode){return(mode&61440)===24576},isFIFO(mode){return(mode&61440)===4096},isSocket(mode){return(mode&49152)===49152},flagsToPermissionString(flag){var perms=["r","w","rw"][flag&3];if(flag&512){perms+="w"}return perms},nodePermissions(node,perms){if(FS.ignorePermissions){return 0}if(perms.includes("r")&&!(node.mode&292)){return 2}if(perms.includes("w")&&!(node.mode&146)){return 2}if(perms.includes("x")&&!(node.mode&73)){return 2}return 0},mayLookup(dir){if(!FS.isDir(dir.mode))return 54;var errCode=FS.nodePermissions(dir,"x");if(errCode)return errCode;if(!dir.node_ops.lookup)return 2;return 0},mayCreate(dir,name){if(!FS.isDir(dir.mode)){return 54}try{var node=FS.lookupNode(dir,name);return 20}catch(e){}return FS.nodePermissions(dir,"wx")},mayDelete(dir,name,isdir){var node;try{node=FS.lookupNode(dir,name)}catch(e){return e.errno}var errCode=FS.nodePermissions(dir,"wx");if(errCode){return errCode}if(isdir){if(!FS.isDir(node.mode)){return 54}if(FS.isRoot(node)||FS.getPath(node)===FS.cwd()){return 10}}else if(FS.isDir(node.mode)){return 31}return 0},mayOpen(node,flags){if(!node){return 44}if(FS.isLink(node.mode)){return 32}var mode=FS.flagsToPermissionString(flags);if(FS.isDir(node.mode)){if(mode!=="r"||flags&(512|64)){return 31}}return FS.nodePermissions(node,mode)},checkOpExists(op,err){if(!op){throw new FS.ErrnoError(err)}return op},MAX_OPEN_FDS:4096,nextfd(){for(var fd=0;fd<=FS.MAX_OPEN_FDS;fd++){if(!FS.streams[fd]){return fd}}throw new FS.ErrnoError(33)},getStreamChecked(fd){var stream=FS.getStream(fd);if(!stream){throw new FS.ErrnoError(8)}return stream},getStream:fd=>FS.streams[fd],createStream(stream,fd=-1){stream=Object.assign(new FS.FSStream,stream);if(fd==-1){fd=FS.nextfd()}stream.fd=fd;FS.streams[fd]=stream;return stream},closeStream(fd){FS.streams[fd]=null},dupStream(origStream,fd=-1){var stream=FS.createStream(origStream,fd);stream.stream_ops?.dup?.(stream);return stream},doSetAttr(stream,node,attr){var setattr=stream?.stream_ops.setattr;var arg=setattr?stream:node;setattr??=node.node_ops.setattr;FS.checkOpExists(setattr,63);try{setattr(arg,attr)}catch(e){if(e instanceof RangeError){throw new FS.ErrnoError(22)}throw e}},chrdev_stream_ops:{open(stream){var device=FS.getDevice(stream.node.rdev);stream.stream_ops=device.stream_ops;stream.stream_ops.open?.(stream)},llseek(){throw new FS.ErrnoError(70)}},major:dev=>dev>>8,minor:dev=>dev&255,makedev:(ma,mi)=>ma<<8|mi,registerDevice(dev,ops){FS.devices[dev]={stream_ops:ops}},getDevice:dev=>FS.devices[dev],getMounts(mount){var mounts=[];var check=[mount];while(check.length){var m=check.pop();mounts.push(m);check.push(...m.mounts)}return mounts},syncfs(populate,callback){if(typeof populate=="function"){callback=populate;populate=false}FS.syncFSRequests++;if(FS.syncFSRequests>1){err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`)}var mounts=FS.getMounts(FS.root.mount);var completed=0;function doCallback(errCode){FS.syncFSRequests--;return callback(errCode)}function done(errCode){if(errCode){if(!done.errored){done.errored=true;return doCallback(errCode)}return}if(++completed>=mounts.length){doCallback(null)}}for(var mount of mounts){if(mount.type.syncfs){mount.type.syncfs(mount,populate,done)}else{done(null)}}},mount(type,opts,mountpoint){var root=mountpoint==="/";var pseudo=!mountpoint;var node;if(root&&FS.root){throw new FS.ErrnoError(10)}else if(!root&&!pseudo){var lookup=FS.lookupPath(mountpoint,{follow_mount:false});mountpoint=lookup.path;node=lookup.node;if(FS.isMountpoint(node)){throw new FS.ErrnoError(10)}if(!FS.isDir(node.mode)){throw new FS.ErrnoError(54)}}var mount={type,opts,mountpoint,mounts:[]};var mountRoot=type.mount(mount);mountRoot.mount=mount;mount.root=mountRoot;if(root){FS.root=mountRoot}else if(node){node.mounted=mount;if(node.mount){node.mount.mounts.push(mount)}}return mountRoot},unmount(mountpoint){var lookup=FS.lookupPath(mountpoint,{follow_mount:false});if(!FS.isMountpoint(lookup.node)){throw new FS.ErrnoError(28)}var node=lookup.node;var mount=node.mounted;var mounts=FS.getMounts(mount);for(var[hash,current]of Object.entries(FS.nameTable)){while(current){var next=current.name_next;if(mounts.includes(current.mount)){FS.destroyNode(current)}current=next}}node.mounted=null;var idx=node.mount.mounts.indexOf(mount);node.mount.mounts.splice(idx,1)},lookup(parent,name){return parent.node_ops.lookup(parent,name)},mknod(path,mode,dev){var lookup=FS.lookupPath(path,{parent:true});var parent=lookup.node;var name=PATH.basename(path);if(!name){throw new FS.ErrnoError(28)}if(name==="."||name===".."){throw new FS.ErrnoError(20)}var errCode=FS.mayCreate(parent,name);if(errCode){throw new FS.ErrnoError(errCode)}if(!parent.node_ops.mknod){throw new FS.ErrnoError(63)}return parent.node_ops.mknod(parent,name,mode,dev)},statfs(path){return FS.statfsNode(FS.lookupPath(path,{follow:true}).node)},statfsStream(stream){return FS.statfsNode(stream.node)},statfsNode(node){var rtn={bsize:4096,frsize:4096,blocks:1e6,bfree:5e5,bavail:5e5,files:FS.nextInode,ffree:FS.nextInode-1,fsid:42,flags:2,namelen:255};if(node.node_ops.statfs){Object.assign(rtn,node.node_ops.statfs(node.mount.opts.root))}return rtn},create(path,mode=438){mode&=4095;mode|=32768;return FS.mknod(path,mode,0)},mkdir(path,mode=511){mode&=511|512;mode|=16384;return FS.mknod(path,mode,0)},mkdirTree(path,mode){var dirs=path.split("/");var d="";for(var dir of dirs){if(!dir)continue;if(d||PATH.isAbs(path))d+="/";d+=dir;try{FS.mkdir(d,mode)}catch(e){if(e.errno!=20)throw e}}},mkdev(path,mode,dev){if(typeof dev=="undefined"){dev=mode;mode=438}mode|=8192;return FS.mknod(path,mode,dev)},symlink(oldpath,newpath){if(!PATH_FS.resolve(oldpath)){throw new FS.ErrnoError(44)}var lookup=FS.lookupPath(newpath,{parent:true});var parent=lookup.node;if(!parent){throw new FS.ErrnoError(44)}var newname=PATH.basename(newpath);var errCode=FS.mayCreate(parent,newname);if(errCode){throw new FS.ErrnoError(errCode)}if(!parent.node_ops.symlink){throw new FS.ErrnoError(63)}return parent.node_ops.symlink(parent,newname,oldpath)},rename(old_path,new_path){var old_dirname=PATH.dirname(old_path);var new_dirname=PATH.dirname(new_path);var old_name=PATH.basename(old_path);var new_name=PATH.basename(new_path);var lookup,old_dir,new_dir;lookup=FS.lookupPath(old_path,{parent:true});old_dir=lookup.node;lookup=FS.lookupPath(new_path,{parent:true});new_dir=lookup.node;if(!old_dir||!new_dir)throw new FS.ErrnoError(44);if(old_dir.mount!==new_dir.mount){throw new FS.ErrnoError(75)}var old_node=FS.lookupNode(old_dir,old_name);var relative=PATH_FS.relative(old_path,new_dirname);if(relative.charAt(0)!=="."){throw new FS.ErrnoError(28)}relative=PATH_FS.relative(new_path,old_dirname);if(relative.charAt(0)!=="."){throw new FS.ErrnoError(55)}var new_node;try{new_node=FS.lookupNode(new_dir,new_name)}catch(e){}if(old_node===new_node){return}var isdir=FS.isDir(old_node.mode);var errCode=FS.mayDelete(old_dir,old_name,isdir);if(errCode){throw new FS.ErrnoError(errCode)}errCode=new_node?FS.mayDelete(new_dir,new_name,isdir):FS.mayCreate(new_dir,new_name);if(errCode){throw new FS.ErrnoError(errCode)}if(!old_dir.node_ops.rename){throw new FS.ErrnoError(63)}if(FS.isMountpoint(old_node)||new_node&&FS.isMountpoint(new_node)){throw new FS.ErrnoError(10)}if(new_dir!==old_dir){errCode=FS.nodePermissions(old_dir,"w");if(errCode){throw new FS.ErrnoError(errCode)}}FS.hashRemoveNode(old_node);try{old_dir.node_ops.rename(old_node,new_dir,new_name);old_node.parent=new_dir}catch(e){throw e}finally{FS.hashAddNode(old_node)}},rmdir(path){var lookup=FS.lookupPath(path,{parent:true});var parent=lookup.node;var name=PATH.basename(path);var node=FS.lookupNode(parent,name);var errCode=FS.mayDelete(parent,name,true);if(errCode){throw new FS.ErrnoError(errCode)}if(!parent.node_ops.rmdir){throw new FS.ErrnoError(63)}if(FS.isMountpoint(node)){throw new FS.ErrnoError(10)}parent.node_ops.rmdir(parent,name);FS.destroyNode(node)},readdir(path){var lookup=FS.lookupPath(path,{follow:true});var node=lookup.node;var readdir=FS.checkOpExists(node.node_ops.readdir,54);return readdir(node)},unlink(path){var lookup=FS.lookupPath(path,{parent:true});var parent=lookup.node;if(!parent){throw new FS.ErrnoError(44)}var name=PATH.basename(path);var node=FS.lookupNode(parent,name);var errCode=FS.mayDelete(parent,name,false);if(errCode){throw new FS.ErrnoError(errCode)}if(!parent.node_ops.unlink){throw new FS.ErrnoError(63)}if(FS.isMountpoint(node)){throw new FS.ErrnoError(10)}parent.node_ops.unlink(parent,name);FS.destroyNode(node)},readlink(path){var lookup=FS.lookupPath(path);var link=lookup.node;if(!link){throw new FS.ErrnoError(44)}if(!link.node_ops.readlink){throw new FS.ErrnoError(28)}return link.node_ops.readlink(link)},stat(path,dontFollow){var lookup=FS.lookupPath(path,{follow:!dontFollow});var node=lookup.node;var getattr=FS.checkOpExists(node.node_ops.getattr,63);return getattr(node)},fstat(fd){var stream=FS.getStreamChecked(fd);var node=stream.node;var getattr=stream.stream_ops.getattr;var arg=getattr?stream:node;getattr??=node.node_ops.getattr;FS.checkOpExists(getattr,63);return getattr(arg)},lstat(path){return FS.stat(path,true)},doChmod(stream,node,mode,dontFollow){FS.doSetAttr(stream,node,{mode:mode&4095|node.mode&~4095,ctime:Date.now(),dontFollow})},chmod(path,mode,dontFollow){var node;if(typeof path=="string"){var lookup=FS.lookupPath(path,{follow:!dontFollow});node=lookup.node}else{node=path}FS.doChmod(null,node,mode,dontFollow)},lchmod(path,mode){FS.chmod(path,mode,true)},fchmod(fd,mode){var stream=FS.getStreamChecked(fd);FS.doChmod(stream,stream.node,mode,false)},doChown(stream,node,dontFollow){FS.doSetAttr(stream,node,{timestamp:Date.now(),dontFollow})},chown(path,uid,gid,dontFollow){var node;if(typeof path=="string"){var lookup=FS.lookupPath(path,{follow:!dontFollow});node=lookup.node}else{node=path}FS.doChown(null,node,dontFollow)},lchown(path,uid,gid){FS.chown(path,uid,gid,true)},fchown(fd,uid,gid){var stream=FS.getStreamChecked(fd);FS.doChown(stream,stream.node,false)},doTruncate(stream,node,len){if(FS.isDir(node.mode)){throw new FS.ErrnoError(31)}if(!FS.isFile(node.mode)){throw new FS.ErrnoError(28)}var errCode=FS.nodePermissions(node,"w");if(errCode){throw new FS.ErrnoError(errCode)}FS.doSetAttr(stream,node,{size:len,timestamp:Date.now()})},truncate(path,len){if(len<0){throw new FS.ErrnoError(28)}var node;if(typeof path=="string"){var lookup=FS.lookupPath(path,{follow:true});node=lookup.node}else{node=path}FS.doTruncate(null,node,len)},ftruncate(fd,len){var stream=FS.getStreamChecked(fd);if(len<0||(stream.flags&2097155)===0){throw new FS.ErrnoError(28)}FS.doTruncate(stream,stream.node,len)},utime(path,atime,mtime){var lookup=FS.lookupPath(path,{follow:true});var node=lookup.node;var setattr=FS.checkOpExists(node.node_ops.setattr,63);setattr(node,{atime,mtime})},open(path,flags,mode=438){if(path===""){throw new FS.ErrnoError(44)}flags=FS_modeStringToFlags(flags);if(flags&64){mode=mode&4095|32768}else{mode=0}var node;var isDirPath;if(typeof path=="object"){node=path}else{isDirPath=path.endsWith("/");var lookup=FS.lookupPath(path,{follow:!(flags&131072),noent_okay:true});node=lookup.node;path=lookup.path}var created=false;if(flags&64){if(node){if(flags&128){throw new FS.ErrnoError(20)}}else if(isDirPath){throw new FS.ErrnoError(31)}else{node=FS.mknod(path,mode|511,0);created=true}}if(!node){throw new FS.ErrnoError(44)}if(FS.isChrdev(node.mode)){flags&=~512}if(flags&65536&&!FS.isDir(node.mode)){throw new FS.ErrnoError(54)}if(!created){var errCode=FS.mayOpen(node,flags);if(errCode){throw new FS.ErrnoError(errCode)}}if(flags&512&&!created){FS.truncate(node,0)}flags&=~(128|512|131072);var stream=FS.createStream({node,path:FS.getPath(node),flags,seekable:true,position:0,stream_ops:node.stream_ops,ungotten:[],error:false});if(stream.stream_ops.open){stream.stream_ops.open(stream)}if(created){FS.chmod(node,mode&511)}return stream},close(stream){if(FS.isClosed(stream)){throw new FS.ErrnoError(8)}if(stream.getdents)stream.getdents=null;try{if(stream.stream_ops.close){stream.stream_ops.close(stream)}}catch(e){throw e}finally{FS.closeStream(stream.fd)}stream.fd=null},isClosed(stream){return stream.fd===null},llseek(stream,offset,whence){if(FS.isClosed(stream)){throw new FS.ErrnoError(8)}if(!stream.seekable||!stream.stream_ops.llseek){throw new FS.ErrnoError(70)}if(whence!=0&&whence!=1&&whence!=2){throw new FS.ErrnoError(28)}stream.position=stream.stream_ops.llseek(stream,offset,whence);stream.ungotten=[];return stream.position},read(stream,buffer,offset,length,position){if(length<0||position<0){throw new FS.ErrnoError(28)}if(FS.isClosed(stream)){throw new FS.ErrnoError(8)}if((stream.flags&2097155)===1){throw new FS.ErrnoError(8)}if(FS.isDir(stream.node.mode)){throw new FS.ErrnoError(31)}if(!stream.stream_ops.read){throw new FS.ErrnoError(28)}var seeking=typeof position!="undefined";if(!seeking){position=stream.position}else if(!stream.seekable){throw new FS.ErrnoError(70)}var bytesRead=stream.stream_ops.read(stream,buffer,offset,length,position);if(!seeking)stream.position+=bytesRead;return bytesRead},write(stream,buffer,offset,length,position,canOwn){if(length<0||position<0){throw new FS.ErrnoError(28)}if(FS.isClosed(stream)){throw new FS.ErrnoError(8)}if((stream.flags&2097155)===0){throw new FS.ErrnoError(8)}if(FS.isDir(stream.node.mode)){throw new FS.ErrnoError(31)}if(!stream.stream_ops.write){throw new FS.ErrnoError(28)}if(stream.seekable&&stream.flags&1024){FS.llseek(stream,0,2)}var seeking=typeof position!="undefined";if(!seeking){position=stream.position}else if(!stream.seekable){throw new FS.ErrnoError(70)}var bytesWritten=stream.stream_ops.write(stream,buffer,offset,length,position,canOwn);if(!seeking)stream.position+=bytesWritten;return bytesWritten},mmap(stream,length,position,prot,flags){if((prot&2)!==0&&(flags&2)===0&&(stream.flags&2097155)!==2){throw new FS.ErrnoError(2)}if((stream.flags&2097155)===1){throw new FS.ErrnoError(2)}if(!stream.stream_ops.mmap){throw new FS.ErrnoError(43)}if(!length){throw new FS.ErrnoError(28)}return stream.stream_ops.mmap(stream,length,position,prot,flags)},msync(stream,buffer,offset,length,mmapFlags){if(!stream.stream_ops.msync){return 0}return stream.stream_ops.msync(stream,buffer,offset,length,mmapFlags)},ioctl(stream,cmd,arg){if(!stream.stream_ops.ioctl){throw new FS.ErrnoError(59)}return stream.stream_ops.ioctl(stream,cmd,arg)},readFile(path,opts={}){opts.flags=opts.flags??0;opts.encoding=opts.encoding??"binary";if(opts.encoding!=="utf8"&&opts.encoding!=="binary"){abort(`Invalid encoding type "${opts.encoding}"`)}var stream=FS.open(path,opts.flags);var stat=FS.stat(path);var length=stat.size;var buf=new Uint8Array(length);FS.read(stream,buf,0,length,0);if(opts.encoding==="utf8"){buf=UTF8ArrayToString(buf)}FS.close(stream);return buf},writeFile(path,data,opts={}){opts.flags=opts.flags??577;var stream=FS.open(path,opts.flags,opts.mode);data=FS_fileDataToTypedArray(data);FS.write(stream,data,0,data.byteLength,undefined,opts.canOwn);FS.close(stream)},cwd:()=>FS.currentPath,chdir(path){var lookup=FS.lookupPath(path,{follow:true});if(lookup.node===null){throw new FS.ErrnoError(44)}if(!FS.isDir(lookup.node.mode)){throw new FS.ErrnoError(54)}var errCode=FS.nodePermissions(lookup.node,"x");if(errCode){throw new FS.ErrnoError(errCode)}FS.currentPath=lookup.path},createDefaultDirectories(){FS.mkdir("/tmp");FS.mkdir("/home");FS.mkdir("/home/web_user")},createDefaultDevices(){FS.mkdir("/dev");FS.registerDevice(FS.makedev(1,3),{read:()=>0,write:(stream,buffer,offset,length,pos)=>length,llseek:()=>0});FS.mkdev("/dev/null",FS.makedev(1,3));TTY.register(FS.makedev(5,0),TTY.default_tty_ops);TTY.register(FS.makedev(6,0),TTY.default_tty1_ops);FS.mkdev("/dev/tty",FS.makedev(5,0));FS.mkdev("/dev/tty1",FS.makedev(6,0));var randomBuffer=new Uint8Array(1024),randomLeft=0;var randomByte=()=>{if(randomLeft===0){randomFill(randomBuffer);randomLeft=randomBuffer.byteLength}return randomBuffer[--randomLeft]};FS.createDevice("/dev","random",randomByte);FS.createDevice("/dev","urandom",randomByte);FS.mkdir("/dev/shm");FS.mkdir("/dev/shm/tmp")},createSpecialDirectories(){FS.mkdir("/proc");var proc_self=FS.mkdir("/proc/self");FS.mkdir("/proc/self/fd");FS.mount({mount(){var node=FS.createNode(proc_self,"fd",16895,73);node.stream_ops={llseek:MEMFS.stream_ops.llseek};node.node_ops={lookup(parent,name){var fd=+name;var stream=FS.getStreamChecked(fd);var ret={parent:null,mount:{mountpoint:"fake"},node_ops:{readlink:()=>stream.path},id:fd+1};ret.parent=ret;return ret},readdir(){return Array.from(FS.streams.entries()).filter(([k,v])=>v).map(([k,v])=>k.toString())}};return node}},{},"/proc/self/fd")},createStandardStreams(input,output,error){if(input){FS.createDevice("/dev","stdin",input)}else{FS.symlink("/dev/tty","/dev/stdin")}if(output){FS.createDevice("/dev","stdout",null,output)}else{FS.symlink("/dev/tty","/dev/stdout")}if(error){FS.createDevice("/dev","stderr",null,error)}else{FS.symlink("/dev/tty1","/dev/stderr")}var stdin=FS.open("/dev/stdin",0);var stdout=FS.open("/dev/stdout",1);var stderr=FS.open("/dev/stderr",1)},staticInit(){FS.nameTable=new Array(4096);FS.mount(MEMFS,{},"/");FS.createDefaultDirectories();FS.createDefaultDevices();FS.createSpecialDirectories();FS.filesystems={MEMFS}},init(input,output,error){FS.initialized=true;input??=Module["stdin"];output??=Module["stdout"];error??=Module["stderr"];FS.createStandardStreams(input,output,error)},quit(){FS.initialized=false;for(var stream of FS.streams){if(stream){FS.close(stream)}}},findObject(path,dontResolveLastLink){var ret=FS.analyzePath(path,dontResolveLastLink);if(!ret.exists){return null}return ret.object},analyzePath(path,dontResolveLastLink){try{var lookup=FS.lookupPath(path,{follow:!dontResolveLastLink});path=lookup.path}catch(e){}var ret={isRoot:false,exists:false,error:0,name:null,path:null,object:null,parentExists:false,parentPath:null,parentObject:null};try{var lookup=FS.lookupPath(path,{parent:true});ret.parentExists=true;ret.parentPath=lookup.path;ret.parentObject=lookup.node;ret.name=PATH.basename(path);lookup=FS.lookupPath(path,{follow:!dontResolveLastLink});ret.exists=true;ret.path=lookup.path;ret.object=lookup.node;ret.name=lookup.node.name;ret.isRoot=lookup.path==="/"}catch(e){ret.error=e.errno}return ret},createPath(parent,path,canRead,canWrite){parent=typeof parent=="string"?parent:FS.getPath(parent);var parts=path.split("/").reverse();while(parts.length){var part=parts.pop();if(!part)continue;var current=PATH.join2(parent,part);try{FS.mkdir(current)}catch(e){if(e.errno!=20)throw e}parent=current}return current},createFile(parent,name,properties,canRead,canWrite){var path=PATH.join2(typeof parent=="string"?parent:FS.getPath(parent),name);var mode=FS_getMode(canRead,canWrite);return FS.create(path,mode)},createDataFile(parent,name,data,canRead,canWrite,canOwn){var path=name;if(parent){parent=typeof parent=="string"?parent:FS.getPath(parent);path=name?PATH.join2(parent,name):parent}var mode=FS_getMode(canRead,canWrite);var node=FS.create(path,mode);if(data){data=FS_fileDataToTypedArray(data);FS.chmod(node,mode|146);var stream=FS.open(node,577);FS.write(stream,data,0,data.length,0,canOwn);FS.close(stream);FS.chmod(node,mode)}},createDevice(parent,name,input,output){var path=PATH.join2(typeof parent=="string"?parent:FS.getPath(parent),name);var mode=FS_getMode(!!input,!!output);FS.createDevice.major??=64;var dev=FS.makedev(FS.createDevice.major++,0);FS.registerDevice(dev,{open(stream){stream.seekable=false},close(stream){if(output?.buffer?.length){output(10)}},read(stream,buffer,offset,length,pos){var bytesRead=0;for(var i=0;i<length;i++){var result;try{result=input()}catch(e){throw new FS.ErrnoError(29)}if(result===undefined&&bytesRead===0){throw new FS.ErrnoError(6)}if(result===null||result===undefined)break;bytesRead++;buffer[offset+i]=result}if(bytesRead){stream.node.atime=Date.now()}return bytesRead},write(stream,buffer,offset,length,pos){for(var i=0;i<length;i++){try{output(buffer[offset+i])}catch(e){throw new FS.ErrnoError(29)}}if(length){stream.node.mtime=stream.node.ctime=Date.now()}return i}});return FS.mkdev(path,mode,dev)},forceLoadFile(obj){if(obj.isDevice||obj.isFolder||obj.link||obj.contents)return true;if(globalThis.XMLHttpRequest){abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.")}else{try{obj.contents=readBinary(obj.url)}catch(e){throw new FS.ErrnoError(29)}}},createLazyFile(parent,name,url,canRead,canWrite){class LazyUint8Array{lengthKnown=false;chunks=[];get(idx){if(idx>this.length-1||idx<0){return undefined}var chunkOffset=idx%this.chunkSize;var chunkNum=idx/this.chunkSize|0;return this.getter(chunkNum)[chunkOffset]}setDataGetter(getter){this.getter=getter}cacheLength(){var xhr=new XMLHttpRequest;xhr.open("HEAD",url,false);xhr.send(null);if(!(xhr.status>=200&&xhr.status<300||xhr.status===304))abort("Couldn't load "+url+". Status: "+xhr.status);var datalength=Number(xhr.getResponseHeader("Content-length"));var header;var hasByteServing=(header=xhr.getResponseHeader("Accept-Ranges"))&&header==="bytes";var usesGzip=(header=xhr.getResponseHeader("Content-Encoding"))&&header==="gzip";var chunkSize=1024*1024;if(!hasByteServing)chunkSize=datalength;var doXHR=(from,to)=>{if(from>to)abort(`invalid range (${from}, ${to}) or no bytes requested!`);if(to>datalength-1)abort(`only ${datalength} bytes available! programmer error!`);var xhr=new XMLHttpRequest;xhr.open("GET",url,false);if(datalength!==chunkSize)xhr.setRequestHeader("Range","bytes="+from+"-"+to);xhr.responseType="arraybuffer";if(xhr.overrideMimeType){xhr.overrideMimeType("text/plain; charset=x-user-defined")}xhr.send(null);if(!(xhr.status>=200&&xhr.status<300||xhr.status===304))abort("Couldn't load "+url+". Status: "+xhr.status);if(xhr.response!==undefined){return new Uint8Array(xhr.response||[])}return intArrayFromString(xhr.responseText??"",true)};var lazyArray=this;lazyArray.setDataGetter(chunkNum=>{var start=chunkNum*chunkSize;var end=(chunkNum+1)*chunkSize-1;end=Math.min(end,datalength-1);if(typeof lazyArray.chunks[chunkNum]=="undefined"){lazyArray.chunks[chunkNum]=doXHR(start,end)}if(typeof lazyArray.chunks[chunkNum]=="undefined")abort("doXHR failed!");return lazyArray.chunks[chunkNum]});if(usesGzip||!datalength){chunkSize=datalength=1;datalength=this.getter(0).length;chunkSize=datalength;out("LazyFiles on gzip forces download of the whole file when length is accessed")}this._length=datalength;this._chunkSize=chunkSize;this.lengthKnown=true}get length(){if(!this.lengthKnown){this.cacheLength()}return this._length}get chunkSize(){if(!this.lengthKnown){this.cacheLength()}return this._chunkSize}}if(globalThis.XMLHttpRequest){if(!ENVIRONMENT_IS_WORKER)abort("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");var lazyArray=new LazyUint8Array;var properties={isDevice:false,contents:lazyArray}}else{var properties={isDevice:false,url}}var node=FS.createFile(parent,name,properties,canRead,canWrite);if(properties.contents){node.contents=properties.contents}else if(properties.url){node.contents=null;node.url=properties.url}Object.defineProperties(node,{usedBytes:{get:function(){return this.contents.length}}});var stream_ops={};for(const[key,fn]of Object.entries(node.stream_ops)){stream_ops[key]=(...args)=>{FS.forceLoadFile(node);return fn(...args)}}function writeChunks(stream,buffer,offset,length,position){var contents=stream.node.contents;if(position>=contents.length)return 0;var size=Math.min(contents.length-position,length);if(contents.slice){for(var i=0;i<size;i++){buffer[offset+i]=contents[position+i]}}else{for(var i=0;i<size;i++){buffer[offset+i]=contents.get(position+i)}}return size}stream_ops.read=(stream,buffer,offset,length,position)=>{FS.forceLoadFile(node);return writeChunks(stream,buffer,offset,length,position)};stream_ops.mmap=(stream,length,position,prot,flags)=>{FS.forceLoadFile(node);var ptr=mmapAlloc(length);if(!ptr){throw new FS.ErrnoError(48)}writeChunks(stream,HEAP8,ptr,length,position);return{ptr,allocated:true}};node.stream_ops=stream_ops;return node}};var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead,ignoreNul):"";var SYSCALLS={currentUmask:18,calculateAt(dirfd,path,allowEmpty){if(PATH.isAbs(path)){return path}var dir;if(dirfd===-100){dir=FS.cwd()}else{var dirstream=SYSCALLS.getStreamFromFD(dirfd);dir=dirstream.path}if(path.length==0){if(!allowEmpty){throw new FS.ErrnoError(44)}return dir}return dir+"/"+path},writeStat(buf,stat){HEAPU32[buf>>2]=stat.dev;HEAPU32[buf+4>>2]=stat.mode;HEAPU32[buf+8>>2]=stat.nlink;HEAPU32[buf+12>>2]=stat.uid;HEAPU32[buf+16>>2]=stat.gid;HEAPU32[buf+20>>2]=stat.rdev;HEAP64[buf+24>>3]=BigInt(stat.size);HEAP32[buf+32>>2]=4096;HEAP32[buf+36>>2]=stat.blocks;var atime=stat.atime.getTime();var mtime=stat.mtime.getTime();var ctime=stat.ctime.getTime();HEAP64[buf+40>>3]=BigInt(Math.floor(atime/1e3));HEAPU32[buf+48>>2]=atime%1e3*1e3*1e3;HEAP64[buf+56>>3]=BigInt(Math.floor(mtime/1e3));HEAPU32[buf+64>>2]=mtime%1e3*1e3*1e3;HEAP64[buf+72>>3]=BigInt(Math.floor(ctime/1e3));HEAPU32[buf+80>>2]=ctime%1e3*1e3*1e3;HEAP64[buf+88>>3]=BigInt(stat.ino);return 0},writeStatFs(buf,stats){HEAPU32[buf+4>>2]=stats.bsize;HEAPU32[buf+60>>2]=stats.bsize;HEAP64[buf+8>>3]=BigInt(stats.blocks);HEAP64[buf+16>>3]=BigInt(stats.bfree);HEAP64[buf+24>>3]=BigInt(stats.bavail);HEAP64[buf+32>>3]=BigInt(stats.files);HEAP64[buf+40>>3]=BigInt(stats.ffree);HEAPU32[buf+48>>2]=stats.fsid;HEAPU32[buf+64>>2]=stats.flags;HEAPU32[buf+56>>2]=stats.namelen},doMsync(addr,stream,len,flags,offset){if(!FS.isFile(stream.node.mode)){throw new FS.ErrnoError(43)}if(flags&2){return 0}var buffer=HEAPU8.subarray(addr,addr+len);FS.msync(stream,buffer,offset,len,flags)},getStreamFromFD(fd){var stream=FS.getStreamChecked(fd);return stream},varargs:undefined,getStr(ptr){var ret=UTF8ToString(ptr);return ret}};function ___syscall_fcntl64(fd,cmd,varargs){SYSCALLS.varargs=varargs;try{var stream=SYSCALLS.getStreamFromFD(fd);switch(cmd){case 0:{var arg=syscallGetVarargI();if(arg<0){return-28}while(FS.streams[arg]){arg++}var newStream;newStream=FS.dupStream(stream,arg);return newStream.fd}case 1:case 2:return 0;case 3:return stream.flags;case 4:{var arg=syscallGetVarargI();var mask=289792;stream.flags=stream.flags&~mask|arg&mask;return 0}case 12:{var arg=syscallGetVarargP();var offset=0;HEAP16[arg+offset>>1]=2;return 0}case 13:case 14:return 0}return-28}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}var stringToUTF8=(str,outPtr,maxBytesToWrite)=>stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite);function ___syscall_getdents64(fd,dirp,count){try{var stream=SYSCALLS.getStreamFromFD(fd);stream.getdents||=FS.readdir(stream.path);var struct_size=280;var pos=0;var off=FS.llseek(stream,0,1);var startIdx=Math.floor(off/struct_size);var endIdx=Math.min(stream.getdents.length,startIdx+Math.floor(count/struct_size));for(var idx=startIdx;idx<endIdx;idx++){var id;var type;var name=stream.getdents[idx];if(name==="."){id=stream.node.id;type=4}else if(name===".."){var lookup=FS.lookupPath(stream.path,{parent:true});id=lookup.node.id;type=4}else{var child;try{child=FS.lookupNode(stream.node,name)}catch(e){if(e?.errno===28){continue}throw e}id=child.id;type=FS.isChrdev(child.mode)?2:FS.isDir(child.mode)?4:FS.isLink(child.mode)?10:8}HEAP64[dirp+pos>>3]=BigInt(id);HEAP64[dirp+pos+8>>3]=BigInt((idx+1)*struct_size);HEAP16[dirp+pos+16>>1]=280;HEAP8[dirp+pos+18]=type;stringToUTF8(name,dirp+pos+19,256);pos+=struct_size}FS.llseek(stream,idx*struct_size,0);return pos}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}function ___syscall_ioctl(fd,op,varargs){SYSCALLS.varargs=varargs;try{var stream=SYSCALLS.getStreamFromFD(fd);switch(op){case 21509:{if(!stream.tty)return-59;return 0}case 21505:{if(!stream.tty)return-59;if(stream.tty.ops.ioctl_tcgets){var termios=stream.tty.ops.ioctl_tcgets(stream);var argp=syscallGetVarargP();HEAP32[argp>>2]=termios.c_iflag||0;HEAP32[argp+4>>2]=termios.c_oflag||0;HEAP32[argp+8>>2]=termios.c_cflag||0;HEAP32[argp+12>>2]=termios.c_lflag||0;for(var i=0;i<32;i++){HEAP8[argp+i+17]=termios.c_cc[i]||0}return 0}return 0}case 21510:case 21511:case 21512:{if(!stream.tty)return-59;return 0}case 21506:case 21507:case 21508:{if(!stream.tty)return-59;if(stream.tty.ops.ioctl_tcsets){var argp=syscallGetVarargP();var c_iflag=HEAP32[argp>>2];var c_oflag=HEAP32[argp+4>>2];var c_cflag=HEAP32[argp+8>>2];var c_lflag=HEAP32[argp+12>>2];var c_cc=[];for(var i=0;i<32;i++){c_cc.push(HEAP8[argp+i+17])}return stream.tty.ops.ioctl_tcsets(stream.tty,op,{c_iflag,c_oflag,c_cflag,c_lflag,c_cc})}return 0}case 21519:{if(!stream.tty)return-59;var argp=syscallGetVarargP();HEAP32[argp>>2]=0;return 0}case 21520:{if(!stream.tty)return-59;return-28}case 21537:case 21531:{var argp=syscallGetVarargP();return FS.ioctl(stream,op,argp)}case 21523:{if(!stream.tty)return-59;if(stream.tty.ops.ioctl_tiocgwinsz){var winsize=stream.tty.ops.ioctl_tiocgwinsz(stream.tty);var argp=syscallGetVarargP();HEAP16[argp>>1]=winsize[0];HEAP16[argp+2>>1]=winsize[1]}return 0}case 21524:{if(!stream.tty)return-59;return 0}case 21515:{if(!stream.tty)return-59;return 0}default:return-28}}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}function ___syscall_mkdirat(dirfd,path,mode){try{path=SYSCALLS.getStr(path);path=SYSCALLS.calculateAt(dirfd,path);mode&=~SYSCALLS.currentUmask;FS.mkdir(path,mode,0);return 0}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}function ___syscall_openat(dirfd,path,flags,varargs){SYSCALLS.varargs=varargs;try{path=SYSCALLS.getStr(path);path=SYSCALLS.calculateAt(dirfd,path);var mode=varargs?syscallGetVarargI():0;if(flags&64){mode&=~SYSCALLS.currentUmask}return FS.open(path,flags,mode).fd}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}function ___syscall_stat64(path,buf){try{path=SYSCALLS.getStr(path);return SYSCALLS.writeStat(buf,FS.stat(path))}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}}var __abort_js=()=>abort("");var runtimeKeepaliveCounter=0;var __emscripten_runtime_keepalive_clear=()=>{noExitRuntime=false;runtimeKeepaliveCounter=0};var INT53_MAX=9007199254740992;var INT53_MIN=-9007199254740992;var bigintToI53Checked=num=>num<INT53_MIN||num>INT53_MAX?NaN:Number(num);var timers={};var handleException=e=>{if(e instanceof ExitStatus||e=="unwind"){return EXITSTATUS}quit_(1,e)};var keepRuntimeAlive=()=>noExitRuntime||runtimeKeepaliveCounter>0;var _proc_exit=code=>{EXITSTATUS=code;if(!keepRuntimeAlive()){Module["onExit"]?.(code);ABORT=true}quit_(code,new ExitStatus(code))};var exitJS=(status,implicit)=>{EXITSTATUS=status;_proc_exit(status)};var _exit=exitJS;var maybeExit=()=>{if(!keepRuntimeAlive()){try{_exit(EXITSTATUS)}catch(e){handleException(e)}}};var callUserCallback=func=>{if(ABORT){return}try{return func()}catch(e){handleException(e)}finally{maybeExit()}};var _emscripten_get_now=()=>performance.now();var __setitimer_js=(which,timeout_ms)=>{if(timers[which]){clearTimeout(timers[which].id);delete timers[which]}if(!timeout_ms)return 0;var id=setTimeout(()=>{delete timers[which];callUserCallback(()=>__emscripten_timeout(which,_emscripten_get_now()))},timeout_ms);timers[which]={id,timeout_ms};return 0};var readEmAsmArgsArray=[];var readEmAsmArgs=(sigPtr,buf)=>{readEmAsmArgsArray.length=0;var ch;while(ch=HEAPU8[sigPtr++]){var wide=ch!=105;wide&=ch!=112;buf+=wide&&buf%8?4:0;readEmAsmArgsArray.push(ch==112?HEAPU32[buf>>2]:ch==106?HEAP64[buf>>3]:ch==105?HEAP32[buf>>2]:HEAPF64[buf>>3]);buf+=wide?8:4}return readEmAsmArgsArray};var runEmAsmFunction=(code,sigPtr,argbuf)=>{var args=readEmAsmArgs(sigPtr,argbuf);return ASM_CONSTS[code](...args)};var _emscripten_asm_const_int=(code,sigPtr,argbuf)=>runEmAsmFunction(code,sigPtr,argbuf);var _emscripten_date_now=()=>Date.now();var _emscripten_exit_with_live_runtime=()=>{throw"unwind"};var getHeapMax=()=>268435456;var growMemory=size=>{var oldHeapSize=wasmMemory.buffer.byteLength;var pages=(size-oldHeapSize+65535)/65536|0;try{wasmMemory.grow(pages);updateMemoryViews();return 1}catch(e){}};var _emscripten_resize_heap=requestedSize=>{var oldSize=HEAPU8.length;requestedSize>>>=0;var maxHeapSize=getHeapMax();if(requestedSize>maxHeapSize){return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignMemory(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=growMemory(newSize);if(replacement){return true}}return false};var ENV={};var getExecutableName=()=>thisProgram;var getEnvStrings=()=>{if(!getEnvStrings.strings){var lang=(globalThis.navigator?.language??"C").replace("-","_")+".UTF-8";var env={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:lang,_:getExecutableName()};for(var x in ENV){if(ENV[x]===undefined)delete env[x];else env[x]=ENV[x]}var strings=[];for(var x in env){strings.push(`${x}=${env[x]}`)}getEnvStrings.strings=strings}return getEnvStrings.strings};var _environ_get=(__environ,environ_buf)=>{var bufSize=0;var envp=0;for(var string of getEnvStrings()){var ptr=environ_buf+bufSize;HEAPU32[__environ+envp>>2]=ptr;bufSize+=stringToUTF8(string,ptr,Infinity)+1;envp+=4}return 0};var _environ_sizes_get=(penviron_count,penviron_buf_size)=>{var strings=getEnvStrings();HEAPU32[penviron_count>>2]=strings.length;var bufSize=0;for(var string of strings){bufSize+=lengthBytesUTF8(string)+1}HEAPU32[penviron_buf_size>>2]=bufSize;return 0};function _fd_close(fd){try{var stream=SYSCALLS.getStreamFromFD(fd);FS.close(stream);return 0}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return e.errno}}var doReadv=(stream,iov,iovcnt,offset)=>{var ret=0;for(var i=0;i<iovcnt;i++){var ptr=HEAPU32[iov>>2];var len=HEAPU32[iov+4>>2];iov+=8;var curr=FS.read(stream,HEAP8,ptr,len,offset);if(curr<0)return-1;ret+=curr;if(curr<len)break;if(typeof offset!="undefined"){offset+=curr}}return ret};function _fd_read(fd,iov,iovcnt,pnum){try{var stream=SYSCALLS.getStreamFromFD(fd);var num=doReadv(stream,iov,iovcnt);HEAPU32[pnum>>2]=num;return 0}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return e.errno}}function _fd_seek(fd,offset,whence,newOffset){offset=bigintToI53Checked(offset);try{if(isNaN(offset))return 22;var stream=SYSCALLS.getStreamFromFD(fd);FS.llseek(stream,offset,whence);HEAP64[newOffset>>3]=BigInt(stream.position);if(stream.getdents&&offset===0&&whence===0)stream.getdents=null;return 0}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return e.errno}}var doWritev=(stream,iov,iovcnt,offset)=>{var ret=0;for(var i=0;i<iovcnt;i++){var ptr=HEAPU32[iov>>2];var len=HEAPU32[iov+4>>2];iov+=8;var curr=FS.write(stream,HEAP8,ptr,len,offset);if(curr<0)return-1;ret+=curr;if(curr<len){break}if(typeof offset!="undefined"){offset+=curr}}return ret};function _fd_write(fd,iov,iovcnt,pnum){try{var stream=SYSCALLS.getStreamFromFD(fd);var num=doWritev(stream,iov,iovcnt);HEAPU32[pnum>>2]=num;return 0}catch(e){if(typeof FS=="undefined"||!(e.name==="ErrnoError"))throw e;return e.errno}}var stackAlloc=sz=>__emscripten_stack_alloc(sz);var stringToUTF8OnStack=str=>{var size=lengthBytesUTF8(str)+1;var ret=stackAlloc(size);stringToUTF8(str,ret,size);return ret};var getCFunc=ident=>{var func=Module["_"+ident];return func};var writeArrayToMemory=(array,buffer)=>{HEAP8.set(array,buffer)};var ccall=(ident,returnType,argTypes,args,opts)=>{var toC={string:str=>{var ret=0;if(str!==null&&str!==undefined&&str!==0){ret=stringToUTF8OnStack(str)}return ret},array:arr=>{var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string"){return UTF8ToString(ret)}if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(stack===0)stack=stackSave();cArgs[i]=converter(args[i])}else{cArgs[i]=args[i]}}}var ret=func(...cArgs);function onDone(ret){if(stack!==0)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret};var cwrap=(ident,returnType,argTypes,opts)=>{var numericArgs=!argTypes||argTypes.every(type=>type==="number"||type==="boolean");var numericRet=returnType!=="string";if(numericRet&&numericArgs&&!opts){return getCFunc(ident)}return(...args)=>ccall(ident,returnType,argTypes,args,opts)};var FS_createPath=(...args)=>FS.createPath(...args);var FS_unlink=(...args)=>FS.unlink(...args);var FS_createLazyFile=(...args)=>FS.createLazyFile(...args);var FS_createDevice=(...args)=>FS.createDevice(...args);FS.createPreloadedFile=FS_createPreloadedFile;FS.preloadFile=FS_preloadFile;FS.staticInit();{if(Module["noExitRuntime"])noExitRuntime=Module["noExitRuntime"];if(Module["print"])out=Module["print"];if(Module["printErr"])err=Module["printErr"];if(Module["arguments"])programArgs=Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];var preInit=Module["preInit"];if(preInit){if(typeof preInit=="function")Module["preInit"]=preInit=[preInit];while(preInit.length>0){preInit.shift()()}}}Module["addRunDependency"]=addRunDependency;Module["removeRunDependency"]=removeRunDependency;Module["ccall"]=ccall;Module["cwrap"]=cwrap;Module["setValue"]=setValue;Module["getValue"]=getValue;Module["FS_preloadFile"]=FS_preloadFile;Module["FS_unlink"]=FS_unlink;Module["FS_createPath"]=FS_createPath;Module["FS_createDevice"]=FS_createDevice;Module["FS"]=FS;Module["FS_createDataFile"]=FS_createDataFile;Module["FS_createLazyFile"]=FS_createLazyFile;var ASM_CONSTS={199316:$0=>{_scheduleMainLoop($0)},199343:()=>{FS.mkdir("/home/web_user/.pcsx");clear_event_history()},199404:($0,$1,$2,$3,$4,$5,$6)=>{render($0,$1,$2,$3,$4,$5,$6)},199436:($0,$1)=>{SendSound($0,$1)}};var _one_iter,_pcsx_init,_ls,_main,_SaveState,_LoadState,_ps1_idle,_ur_info,_get_ptr,_ps1_multitap,_ps1_mt_poke,_emscripten_builtin_memalign,__emscripten_timeout,__emscripten_stack_restore,__emscripten_stack_alloc,_emscripten_stack_get_current,memory,__indirect_function_table,wasmMemory;function assignWasmExports(wasmExports){_one_iter=Module["_one_iter"]=wasmExports["y"];_pcsx_init=Module["_pcsx_init"]=wasmExports["z"];_ls=Module["_ls"]=wasmExports["A"];_main=Module["_main"]=wasmExports["B"];_SaveState=Module["_SaveState"]=wasmExports["C"];_LoadState=Module["_LoadState"]=wasmExports["D"];_ps1_idle=Module["_ps1_idle"]=wasmExports["E"];_ur_info=Module["_ur_info"]=wasmExports["F"];_get_ptr=Module["_get_ptr"]=wasmExports["G"];_ps1_multitap=Module["_ps1_multitap"]=wasmExports["H"];_ps1_mt_poke=Module["_ps1_mt_poke"]=wasmExports["I"];_emscripten_builtin_memalign=wasmExports["J"];__emscripten_timeout=wasmExports["K"];__emscripten_stack_restore=wasmExports["L"];__emscripten_stack_alloc=wasmExports["M"];_emscripten_stack_get_current=wasmExports["N"];memory=wasmMemory=wasmExports["w"];__indirect_function_table=wasmExports["__indirect_function_table"]}var wasmImports={d:___syscall_fcntl64,p:___syscall_getdents64,u:___syscall_ioctl,s:___syscall_mkdirat,h:___syscall_openat,o:___syscall_stat64,k:__abort_js,r:__emscripten_runtime_keepalive_clear,l:__setitimer_js,a:_emscripten_asm_const_int,e:_emscripten_date_now,v:_emscripten_exit_with_live_runtime,c:_emscripten_get_now,m:_emscripten_resize_heap,i:_environ_get,j:_environ_sizes_get,n:_exit,b:_fd_close,g:_fd_read,t:_fd_seek,f:_fd_write,q:_proc_exit};function callMain(args=[]){var entryFunction=_main;args.unshift(thisProgram);var argc=args.length;var argv=stackAlloc((argc+1)*4);var argv_ptr=argv;for(var arg of args){HEAPU32[argv_ptr>>2]=stringToUTF8OnStack(arg);argv_ptr+=4}HEAPU32[argv_ptr>>2]=0;try{var ret=entryFunction(argc,argv);exitJS(ret,true);return ret}catch(e){return handleException(e)}}async function run(args=programArgs){preRun();if(runDependencies){await resolveRunDependencies()}var setStatus=Module["setStatus"];if(setStatus){setStatus("Running...");await new Promise(resolve=>setTimeout(resolve,1));setTimeout(setStatus,1,"")}if(ABORT)return;initRuntime();Module["onRuntimeInitialized"]?.();var noInitialRun=Module["noInitialRun"]||false;if(!noInitialRun)callMain(args);postRun()}var wasmExports;createWasm().then(()=>run());var Module;if(!Module)Module={};var __workerReady=false;function __notifyReady(){if(__workerReady)return;__workerReady=true;try{postMessage({cmd:"workerReady"})}catch(e){}}var __origPostRun=Module["postRun"];Module["postRun"]=function(){if(__origPostRun){if(typeof __origPostRun==="function"){__origPostRun()}else{for(var i=0;i<__origPostRun.length;i++){__origPostRun[i]()}}}__notifyReady()};Module["onRuntimeInitialized"]=function(){__notifyReady()};(function(){var _mloopCh,_mloopPending=false,_mloopDelay=0;if(typeof MessageChannel!=="undefined"){_mloopCh=new MessageChannel;_mloopCh.port1.onmessage=function(){_mloopPending=false;if(_mloopDelay>1){setTimeout(pcsx_mainloop,_mloopDelay)}else{pcsx_mainloop()}}}globalThis._scheduleMainLoop=function(d){_mloopDelay=d|0;if(_mloopCh){if(_mloopPending)return;_mloopPending=true;_mloopCh.port2.postMessage(0)}else{setTimeout(pcsx_mainloop,Math.max(_mloopDelay,0))}}})();Module.setStatus=function(s){postMessage({cmd:"print",txt:s})};function cout_print(s){postMessage({cmd:"print",txt:s})}function set_progress(k,r){postMessage({cmd:"setUI",key:k+"_progress",properties:r})}Module["print"]=cout_print;var vram_ptr,soundbuffer_ptr,isMute_ptr;var vram_dels=0,vram_cres=0;var vram_arrs=[];var vramSab=null,vramI32=null,vramBytes=null;var render=function(x,y,sx,sy,dx,dy,rgb24){var vram_span=vramSpan(x,y,sx,sy,rgb24),vram_lo=vram_span[0],vram_hi=vram_span[1];var vram_src=Module.HEAPU8.subarray(vram_ptr+vram_lo,vram_ptr+vram_hi);if(vramBytes){Atomics.add(vramI32,0,1);vramBytes.set(vram_src,vram_lo);Atomics.store(vramI32,8,vram_lo);Atomics.store(vramI32,9,vram_hi);Atomics.store(vramI32,1,x);Atomics.store(vramI32,2,y);Atomics.store(vramI32,3,sx);Atomics.store(vramI32,4,sy);Atomics.store(vramI32,5,dx);Atomics.store(vramI32,6,dy);Atomics.store(vramI32,7,rgb24);Atomics.add(vramI32,0,1);postMessage({cmd:"renderTick"});return}var vram_arr;while(vram_arrs.length>10){vram_arrs.pop();vram_dels++}if(vram_arrs.length>0){vram_arr=vram_arrs.pop()}else{vram_cres++;vram_arr=new Uint8Array(1024*2048)}vram_arr.set(vram_src,vram_lo);postMessage({cmd:"render",x,y,sx,sy,dx,dy,rgb24,lo:vram_lo,hi:vram_hi,vram:vram_arr},[vram_arr.buffer])};var pSound_arrs=[];var SendSound=function(pSound_ptr,lBytes){var pSound_arr;var pSound_src=Module.HEAPU8.subarray(pSound_ptr,pSound_ptr+lBytes);while(pSound_arrs.length>30){pSound_arrs.pop()}if(pSound_arrs.length>0){pSound_arr=pSound_arrs.pop()}else{pSound_arr=new Uint8Array(4096)}pSound_arr.set(pSound_src);postMessage({cmd:"SoundFeedStreamData",pSound:pSound_arr,lBytes},[pSound_arr.buffer])};function pcsx_mainloop(){_one_iter()}var pcsx_init=Module.cwrap("pcsx_init","number",["string"]);var ls=Module.cwrap("ls","null",["string"]);var padStatus1;var _romName,_romSize=0,_romUrls=null,_romCache=null,_romHits=0,_romMisses=0;var _LAZY_CACHE_CAP=2;function _lazyFetchChunkSync(chunkIdx){var u=_romUrls[chunkIdx];Module.setStatus("Fetching chunk "+chunkIdx+"...");var xhr=new XMLHttpRequest;try{xhr.open("GET",u.url,false);xhr.responseType="arraybuffer";xhr.send()}catch(e){cout_print("[lazy] full-chunk fetch threw: "+e+" url="+u.url+"\n");Module.setStatus("Running!");throw e}Module.setStatus("Running!");if(xhr.status<200||xhr.status>=300){cout_print("[lazy] full-chunk bad status="+xhr.status+" url="+u.url+"\n");throw new Error("chunk fetch "+xhr.status)}var resp=xhr.response;if(!resp||resp.byteLength===0){cout_print("[lazy] full-chunk empty url="+u.url+"\n");throw new Error("chunk empty")}var bytes=new Uint8Array(resp);if(u.byteLength!==bytes.length){cout_print("[lazy-fix] chunk "+chunkIdx+" url="+u.url.split("/").pop()+" declared len="+u.byteLength+" actual="+bytes.length+"; correcting offsets\n");u.byteLength=bytes.length;u.end=u.start+bytes.length;var __o=u.end;for(var __k=chunkIdx+1;__k<_romUrls.length;__k++){_romUrls[__k].start=__o;_romUrls[__k].end=__o+_romUrls[__k].byteLength;__o=_romUrls[__k].end}}cout_print("[lazy] fetched chunk "+chunkIdx+" "+(bytes.length>>20)+" MB (uncached, status="+xhr.status+")\n");return bytes}function _lazyGetChunk(chunkIdx){if(_romCache.has(chunkIdx)){_romHits++;var c=_romCache.get(chunkIdx);_romCache.delete(chunkIdx);_romCache.set(chunkIdx,c);return c}_romMisses++;var c=_lazyFetchChunkSync(chunkIdx);_romCache.set(chunkIdx,c);if(_romCache.size>_LAZY_CACHE_CAP){_romCache.delete(_romCache.keys().next().value)}return c}function _lazyRead(stream,buffer,offset,length,position){if(position>=_romSize)return 0;var size=Math.min(_romSize-position,length);var read=0;while(read<size){var found=false;for(var i=0;i<_romUrls.length;i++){var u=_romUrls[i];if(position>=u.start&&position<u.end){var localOffset=position-u.start;var take=Math.min(u.byteLength-localOffset,size-read);var chunk=_lazyGetChunk(i);buffer.set(chunk.subarray(localOffset,localOffset+take),offset+read);position+=take;read+=take;found=true;break}}if(!found){cout_print("[lazy] no chunk for byte "+position+" (size="+_romSize+")\n");break}}return read}var readfile_and_run=function(iso_name,blob){var run_arr=function(arr){FS.createDataFile("/",iso_name,arr,true,true);Module.setStatus("Running!");pcsx_init("/"+iso_name);padStatus1=_get_ptr(-2);vram_ptr=_get_ptr(-1);soundbuffer_ptr=_get_ptr(7);isMute_ptr=_get_ptr(8);cout_print("before mainloop\n");pcsx_mainloop()};cout_print("readfile and run ");var reader=new FileReader;Module.setStatus("reading file");reader.onprogress=function(e){if(e.lengthComputable){set_progress("readfile",{value:e.loaded,max:e.total,hidden:false})}else cout_print(e.loaded+"bytes")};reader.onload=function(e){cout_print(""+iso_name+" loaded");set_progress("readfile",{value:1,max:1,hidden:false});run_arr(new Uint8Array(this.result))};reader.readAsArrayBuffer(blob)};var event_history=[];var clear_event_history=function(){self.onmessage=main_onmessage;for(var i in event_history){main_onmessage(event_history[i])}event_history=[];Module.setStatus=function(s){postMessage({cmd:"setStatus",txt:s})};setTimeout("Module.setStatus('Open an iso file using the above button(worker ready!).')",1)};var pre_onmessage=function(event){var c=event.data.cmd;if(c=="romBegin"||c=="romChunk"||c=="romEnd"){if(c=="romEnd"){clear_event_history();setTimeout(function(){main_onmessage(event)},0)}else{main_onmessage(event)}return}if(c!="soundBytes"){event_history.push(event);cout_print("push event"+c)}};self.onmessage=pre_onmessage;var main_onmessage=function(event){var data=event.data;switch(data.cmd){case"vramSab":{vramSab=data.sab;vramI32=new Int32Array(vramSab,0,16);vramBytes=new Uint8Array(vramSab,64,1024*2048);break}case"padStatus":Module.HEAPU8.set(data.states,padStatus1);postMessage({cmd:"return_states",states:data.states},[data.states.buffer]);break;case"soundBytes":Module.setValue(soundbuffer_ptr,Module.getValue(soundbuffer_ptr,"i32")-data.lBytes,"i32");break;case"return_vram":vram_arrs.push(data.vram);break;case"return_pSound":pSound_arrs.push(data.pSound);break;case"ls":ls(data.dir);break;case"loadfile":Module.setStatus("Downloading...");cout_print(data.file.name);readfile_and_run(data.file.name,data.file);break;case"loadurl":cout_print("load..."+data.iso);load_or_fetch(data.iso);break;case"saveState":try{Module.ccall("SaveState","number",["string"],["/tmp/state"]);var savedBytes=Module.FS.readFile("/tmp/state");postMessage({cmd:"stateSaved",heap:savedBytes.buffer},[savedBytes.buffer])}catch(e){cout_print("saveState failed: "+e);postMessage({cmd:"stateSaved",heap:new ArrayBuffer(0)})}break;case"loadState":try{var loadBytes=new Uint8Array(data.heap);try{Module.FS.unlink("/tmp/state")}catch(e){}Module.FS.writeFile("/tmp/state",loadBytes);Module.ccall("LoadState","number",["string"],["/tmp/state"]);postMessage({cmd:"stateLoaded"})}catch(e){cout_print("loadState failed: "+e);postMessage({cmd:"stateLoaded"})}break;case"romBegin":try{_romName=data.name;_romSize=data.size|0;if(data.urls){_romUrls=data.urls;var __off=0;for(var __i=0;__i<_romUrls.length;__i++){_romUrls[__i].start=__off;_romUrls[__i].end=__off+_romUrls[__i].byteLength;__off=_romUrls[__i].end}for(var __j=0;__j<_romUrls.length;__j++){cout_print("[lazy-url] "+__j+" "+_romUrls[__j].url.split("/").pop()+" start="+_romUrls[__j].start+" len="+_romUrls[__j].byteLength+" end="+_romUrls[__j].end+"\n")}cout_print("[lazy-url] total declared="+__off+" rom_size="+_romSize+(__off!==_romSize?" MISMATCH":"")+"\n");_romCache=new Map;_romHits=0;_romMisses=0;_romBuffer=null;if(data.preload){var __pre=new Uint8Array(data.preload);_romCache.set(0,__pre);if(_romUrls[0].byteLength!==__pre.length){cout_print("[lazy-fix] preload chunk 0 declared="+_romUrls[0].byteLength+" actual="+__pre.length+"; correcting offsets\n");_romUrls[0].byteLength=__pre.length;_romUrls[0].end=_romUrls[0].start+__pre.length;var __o=_romUrls[0].end;for(var __k=1;__k<_romUrls.length;__k++){_romUrls[__k].start=__o;_romUrls[__k].end=__o+_romUrls[__k].byteLength;__o=_romUrls[__k].end}}cout_print("romBegin preload chunk 0 = "+__pre.length+" bytes\n")}try{FS.unlink("/"+_romName)}catch(e){}var __ls=FS.open("/"+_romName,"w+");FS.close(__ls);var __ln=FS.lookupPath("/"+_romName).node;__ln.usedBytes=_romSize;__ln.stream_ops=Object.assign({},MEMFS.stream_ops,{read:_lazyRead});cout_print("romBegin lazy "+_romName+" size="+_romSize+" chunks="+_romUrls.length+"\n")}else{try{FS.unlink("/"+_romName)}catch(e){}_romBuffer=FS.open("/"+_romName,"w");_romOffset=0;if(_romSize>0){try{FS.truncate("/"+_romName,_romSize)}catch(e){cout_print("romBegin truncate failed: "+e+"\n")}}cout_print("romBegin "+_romName+" streaming hint="+_romSize+"\n")}}catch(e){cout_print("romBegin failed: "+e);_romBuffer=null}break;case"romChunk":if(_romUrls){break}try{if(!_romBuffer){cout_print("romChunk without romBegin\n");break}var _c=new Uint8Array(data.buf);FS.write(_romBuffer,_c,0,_c.length);_romOffset+=_c.length}catch(e){cout_print("romChunk failed at offset "+_romOffset+": "+e);try{FS.close(_romBuffer)}catch(_){}_romBuffer=null}break;case"romEnd":try{if(_romUrls){Module.setStatus("Running!");pcsx_init("/"+_romName);padStatus1=_get_ptr(-2);vram_ptr=_get_ptr(-1);soundbuffer_ptr=_get_ptr(7);isMute_ptr=_get_ptr(8);cout_print("romEnd lazy-booted hits="+_romHits+" misses="+_romMisses+"\n");pcsx_mainloop();break}if(!_romBuffer){cout_print("romEnd without stream\n");break}try{FS.close(_romBuffer)}catch(_){}_romBuffer=null;if(_romSize>0&&_romOffset!=_romSize){try{FS.truncate("/"+_romName,_romOffset)}catch(e){cout_print("romEnd truncate-fix failed: "+e+"\n")}}Module.setStatus("Running!");pcsx_init("/"+_romName);padStatus1=_get_ptr(-2);vram_ptr=_get_ptr(-1);soundbuffer_ptr=_get_ptr(7);isMute_ptr=_get_ptr(8);cout_print("romEnd booted, "+_romOffset+" bytes\n");pcsx_mainloop()}catch(e){cout_print("romEnd failed: "+e)}break;default:postMessage({cmd:"print",txt:"unknown command "+data.cmd})}};cout_print("worker started\n");onerror=function(event){Module.setStatus("Exception thrown, see JavaScript console "+String(event))};(function(){var orig=main_onmessage;main_onmessage=function(event){var d=event.data;if(d&&d.cmd==="netMultitap"){var r=-1;try{r=Module._ps1_multitap(d.slots|0)}catch(e){}postMessage({cmd:"netMultitapResult",slots:r});return}if(d&&d.cmd==="netMtPoke"){var v=-1;try{v=Module._ps1_mt_poke()}catch(e){}postMessage({cmd:"netMtPokeResult",v});return}return orig.apply(this,arguments)}})();

/* ══ LOCKSTEP FRAME GATE ═══════════════════════════════════════════════════
   Appended by hand, like the rest of this file's patches (see CLAUDE.md
   "the current JS-side patches ... live in ps1/ps1Wasm/dist/wasmpsx_worker.js").
   NO CORE REBUILD IS INVOLVED and none is needed:

     * `_one_iter` runs exactly one guest frame and is already exported
       (pcsx-wasm-src/Makefile.modern:7 WORKER_EXPORT=...,_one_iter,...).
     * the core self-drives by ending one_iter with an EM_ASM whose body is
       `_scheduleMainLoop($0)` — ASM_CONSTS[199284] in this file. That body is
       JS: `grep -c -a scheduleMainLoop wasmpsx_worker.wasm` = 0. The wasm
       resolves the bare name from the worker global scope at call time, so
       reassigning globalThis._scheduleMainLoop redirects one_iter's tail.
     * both pads already cross the wire: padStatus1 = _get_ptr(-2) =
       &g.PadState[0] (plugins/dfxvideo/draw_null.c:112-116 -> pad_worker.c
       get_PadState_ptr), the page copies 48 bytes = 2 x sizeof(PADSTATE) (24,
       measured), and PADstartPoll(2) reads g.PadState[1].

   The gate is armed from the WORKER URL (?netgate=1), not from a message,
   because pcsx_init() starts the self-drive chain from inside romEnd — a
   message could not land before the first frame. Armed at URL level, the
   guest runs frame 0 under the gate, so both peers execute an identical
   frame sequence from reset.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  var q = '';
  try { q = String((self.location && self.location.search) || ''); } catch (e) {}
  var GATE = /[?&]netgate=1/.test(q);   // reassigned by 'netUngate'

  var origSched = globalThis._scheduleMainLoop;
  var schedCalls = 0, schedNonZero = 0, schedMin = 1e9, schedMax = -1e9;
  globalThis._scheduleMainLoop = function (d) {
    d = d | 0;
    schedCalls++;
    if (d !== 0) schedNonZero++;
    if (d < schedMin) schedMin = d;
    if (d > schedMax) schedMax = d;
    if (GATE) return;                 // the page drives frames instead
    if (TAKE) return paceSchedule();  // solo: the ONE governor (see paceSchedule)
    return origSched.apply(this, arguments);
  };

  // FNV-1a over a byte range. Used on a SAVESTATE, which is the canonical
  // full guest state (psxM + registers + GPU + SPU + counters), rather than on
  // VRAM: VRAM is downstream of GPUupdateLace1(), which one_iter runs only when
  // `updated_display != -1` — i.e. only when the dfxvideo frame limiter is live
  // — so a VRAM hash could report a host-clock artifact as a desync.
  function fnv1a(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // ⚠ THE FIRST 10 BYTES ARE SKIPPED, AND THAT IS NOT COSMETIC. SaveState()
  // writes through gzopen/gzwrite (libpcsxcore/misc.c), so the file is a GZIP
  // stream whose fixed 10-byte header carries an MTIME field. zlib's gzopen
  // does not call deflateSetHeader, so MTIME *should* be 0 and the bytes
  // deterministic — but resting a desync detector on that would mean a false
  // DIVERGED on every checkpoint if it were ever untrue. Hashing from offset 10
  // removes the question. `head` is reported so a mismatch can be attributed to
  // the header rather than to guest state.
  var GZ_HEADER = 10;

  // ⚠ THE GZIPPED SAVESTATE COSTS ~200 ms PER FINGERPRINT, AND THE PAGE ASKS
  // FOR ONE EVERY SECOND. Measured (/tmp/claude-0/ps1hash.mjs, Monster Rancher
  // 2, desktop Chrome): 188 / 218 / 212 / 241 / 224 / 204 ms each — SaveState()
  // deflates ~3.5 MB through gzwrite (libpcsxcore/misc.c:497-530). This worker
  // is single-threaded, so every fingerprint froze the core for ~12 frames the
  // page could never give back (it may not sprint — CLAUDE.md gate #9). That
  // was the whole of the PS1 room's 0.84x and its ~300 audio dropouts/min in
  // tools/netplay_device_matrix.mjs, against 0.999x solo.
  //
  // So the fingerprint is now FNV over the guest's MAIN RAM and hardware page
  // directly — psxM (2 MB) + psxH (64 KB), the same bytes SaveState writes
  // first (misc.c:513-515) — which costs ~1-2 ms. They are found through the
  // core's own read lookup table: psxMemInit fills psxMemRLUT[i] =
  // &psxM[(i & 0x1f) << 16] for i < 0x80, [0x1f80] = psxH and
  // [0x1fc0 + i] = &psxR[i << 16] (libpcsxcore/psxmem.c:85-93) — a pattern
  // no other data in the heap has. The search runs ONCE, on the first
  // fingerprint, which both peers take at the same frame on the same build.
  //   Coverage trade, stated: CPU registers, GPU and SPU state are no longer
  //   hashed directly; a divergence there is caught once it reaches RAM, which
  //   game logic does within frames. ?nethash=full restores the savestate hash
  //   (and its cost) for an investigation. If the table is ever NOT found the
  //   old hash is used, and the log says so.
  var FULL_HASH = /[?&]nethash=full/.test(q);

  // ⚠ ONE GOVERNOR, NOT TWO. Under the gate the PAGE paces the console
  // (ps1.html lsTick: rAF credit at exactly 59.94 Hz). The core carries its
  // own frame limiter too — dfxvideo FrameCap(), a busy-wait on
  // gettimeofday/emscripten_get_now (plugins/dfxvideo/fps.c:79-124) — and it
  // kept running inside every gated step. Two independent clocks each capping
  // the same frame rate lose to each other's jitter, and this one also paced
  // at its OWN notion of the frame period: measured with
  // tools/netplay_device_matrix.mjs, a gated worker fed WITHOUT any page
  // pacing still produced only ~50 frames/s (/tmp/npdm/ps1-a-coreexp) while
  // spending ~45% of its time inside emscripten_get_now (worker CPU profile,
  // /tmp/npdm/ps1-a-prof). Solo, the same limiter spun ~80% of the time.
  // So while gated, the core's clock is stepped forward a full second at the
  // start of every step: FrameCap then always finds the frame overdue and
  // returns without waiting. performance.now is patched only in THIS worker
  // and only after the first gated step; it stays monotonic. The guest never
  // reads this clock into its state (the full-savestate fingerprints of the
  // two peers agreed while their wall clocks differed).
  var netSkew = 0, netClockPatched = false;
  function netClockJump() {
    if (!GATE) return;
    if (!netClockPatched) {
      netClockPatched = true;
      var realNow = performance.now.bind(performance);
      performance.now = function () { return realNow() + netSkew; };
      // gettimeofday reaches JS through Date.now (emscripten_date_now), and
      // the limiter's tick arithmetic reads THAT clock while its usleep spins
      // on performance.now — both have to move or the wait is only moved.
      var realDate = Date.now;
      Date.now = function () { return realDate() + netSkew; };
    }
    netSkew += 1000;
  }
  var memMap = null, memMapTried = false;
  function locateMem() {
    var h = new Int32Array(Module.HEAPU8.buffer);
    var n = h.length - 0x2000;
    for (var i = 0; i < n; i++) {
      var m = h[i];
      if (m === 0 || h[i + 1] !== ((m + 0x10000) | 0)) continue;
      if (h[i + 0x1f] !== ((m + 0x1f0000) | 0) || h[i + 0x20] !== m || h[i + 0x7f] !== ((m + 0x1f0000) | 0)) continue;
      var R = h[i + 0x1fc0];
      if (!R || h[i + 0x1fc1] !== ((R + 0x10000) | 0)) continue;   // the READ table maps the BIOS; the write table does not
      var H = h[i + 0x1f80];
      if (!H) continue;
      return { m: m >>> 0, hw: H >>> 0, table: (i * 4) >>> 0 };
    }
    return null;
  }
  function fnvWords(u32, h) {
    for (var i = 0; i < u32.length; i++) h = Math.imul(h ^ u32[i], 16777619);
    return h;
  }
  function ramHash() {
    var buf = Module.HEAPU8.buffer;
    var h = 0x811c9dc5 | 0;
    h = fnvWords(new Uint32Array(buf, memMap.m, 0x200000 >> 2), h);
    h = fnvWords(new Uint32Array(buf, memMap.hw, 0x10000 >> 2), h);
    return h >>> 0;
  }
  function stateHash() {
    if (!FULL_HASH) {
      if (!memMapTried) {
        memMapTried = true;
        try { memMap = locateMem(); } catch (e) { memMap = null; }
        try { postMessage({ cmd: 'print', txt: '[lockstep] fingerprint = ' + (memMap ? 'RAM (psxM@0x' + memMap.m.toString(16) + ' + psxH@0x' + memMap.hw.toString(16) + ')' : 'SAVESTATE (the RAM table was not found — ~200 ms per fingerprint)') }); } catch (e) {}
      }
      if (memMap) {
        try { return { hash: ramHash(), len: 0x210000, head: null }; } catch (e) { /* fall through to the savestate */ }
      }
    }
    try {
      Module.ccall('SaveState', 'number', ['string'], ['/tmp/nphash']);
      var b = Module.FS.readFile('/tmp/nphash');
      var body = b.length > GZ_HEADER ? b.subarray(GZ_HEADER) : b;
      var h = fnv1a(body);
      var head = Array.prototype.slice.call(b.subarray(0, 12));
      try { Module.FS.unlink('/tmp/nphash'); } catch (e) {}
      return { hash: h, len: b.length, head: head };
    } catch (e) {
      return { hash: 0, len: 0, head: null, err: String(e) };
    }
  }

  // ⚠ AUDIO CREDIT IS A GUEST-STATE WRITE, AND ASYNCHRONOUS AUDIO CREDIT
  // DESYNCS A ROOM. SoundGetBytesBuffered_value only ever INCREASES
  // (dfsound/worker.c:84 `+=lBytes`); its ONE decrement is the page's
  // 'soundBytes' reply, which arrives on the page's audio-drain schedule — i.e.
  // on a per-peer wall clock. dfsound/spu.c:469-474 makes SPUasync BAIL while
  // that counter is over TESTSIZE (24192), so two peers whose drains ran at
  // different moments mix different amounts of audio and their SPU state
  // diverges. Under the gate the counter is instead zeroed INSIDE each gated
  // step: a pure function of the emulated frame index, and behaviourally what a
  // perfectly-draining sink looks like (SPUasync always mixes).
  // ⚠ ZERO WAS "A PERFECTLY-DRAINING SINK" — ONE THAT DRAINS INFINITELY FAST.
  // With the counter zeroed every step, SPUasync never saw a full buffer and
  // mixed on every call, so a gated core PRODUCED ~7x real-time audio:
  // measured 16.2 M sample frames in ~50 s of a two-player room (~320 k/s
  // against 44,100/s; ps1.html's AudioDiag framesProduced,
  // /tmp/npdm/ps1-a-fix5). The page's SDL queue cannot play that, and what
  // came out was 21-23% audible with ~310 dropouts/min, against 85% audible
  // and ~22/min solo. So the gated sink now drains at the rate a real one
  // does — one emulated frame's worth of 44.1 kHz stereo s16 per step,
  // 44100 * 4 / 59.94 = 2943 bytes — still a pure function of the frame
  // index, so the determinism argument above is untouched, and the SPU mixes
  // exactly as much as the guest's own time produces.
  var GATED_DRAIN = Math.round(44100 * 4 / 59.94);
  function creditAudio() {
    if (!GATE) return;
    try {
      if (typeof soundbuffer_ptr !== 'undefined' && soundbuffer_ptr) {
        // One frame of 44.1 kHz stereo s16 at the DISC's rate (coreHz: 59.94
        // NTSC / 50 PAL once the takeover has read Config.PsxType).
        var v = Module.getValue(soundbuffer_ptr, 'i32') - (TAKE ? Math.round(44100 * 4 / coreHz) : GATED_DRAIN);
        Module.setValue(soundbuffer_ptr, v > 0 ? v : 0, 'i32');
      }
    } catch (e) {}
  }

  // ⚠ ZERO UNGATED FRAMES. romEnd (both the lazy and the streaming branch) ends
  // with pcsx_mainloop(), which runs one _one_iter() before the no-op scheduler
  // stops the chain. That frame is one the PAGE never asked for. Every peer
  // would run it identically so it is not itself a desync, but it makes "the
  // core has run exactly the frames the gate admitted" untestable — and that
  // ordering is the property that cannot be recovered from once broken. Under
  // the gate the pump does nothing; 'netUngate' clears GATE first, so handing
  // the console back still restarts it.
  var origMainloop = pcsx_mainloop;
  pcsx_mainloop = function () {
    if (GATE) return;
    arSoloCredit();
    if (TAKE) { runFrame(); return; }
    return origMainloop.apply(this, arguments);
  };

  // ══ ONE GOVERNOR, REGION-CORRECT, AND A FAST EXACT SAVESTATE ═══════════════
  //
  // (1) THE RATE BUG. Measured solo with the page's own start path, the worker's
  // one_iter count per second (one_iter = exactly one guest vblank:
  // psxcounters.c:293-298 raises DoGPUUpdate once per frame):
  //     Monster Rancher 2 (SLUS00917) ...... 49.99 /s   <- NTSC disc at 50
  //     Metal Gear Solid D1 (SLUS00594) .... 59.06 /s
  //     Harry Potter (SLUS01415) ........... 60.31 /s
  //     Legend of Dragoon D1 (SCUS94491) ... 59.66 /s
  // EVERY disc in ps1.html's ROMS[] is NTSC-U (SYSTEM.CNF BOOT=SLUS_/SCUS_, the
  // license sector reads "Sony Computer Entertainment Amer ica"), and the core
  // agrees: CheckCdrom() leaves Config.PsxType NTSC (libpcsxcore/misc.c:362-365;
  // 0x8A3AF = 566191 in this build reads 0), so each one_iter is 1/60 s of guest
  // CPU time. The 50 came from the GPU PLUGIN's limiter, not the console:
  // dfxvideo SetAutoFrameCap() paces at `PSXDisplay.PAL ? 50 : 59.94`
  // (fps.c:359; the select at 0x8AD30 = 568624 in this build), and PSXDisplay.PAL
  // is whatever bit 3 of the guest's last GP1(08h) was (gpu.c:956). Monster
  // Rancher 2's first GP1(08h) sets it (GPUSTAT read 0xd4922200 at vblank 316:
  // bit 20 set) — so the limiter slowed an NTSC console to 50 Hz, i.e. the
  // guest ran at 0.833x. [CORRECTED: that 50 Hz was right for the wrong
  // reason. MR2 keeps the PAL bit set with the display on through play, and the
  // hardware's vblank rate follows that bit — see "THE VBLANK RATE FOLLOWS THE
  // GPU'S VIDEO-MODE BIT" below, which now paces it at 50 Hz from the GPU's
  // own mode, with the core's frame timed as PAL to match.] The other three titles merely wandered ±1.5% around
  // 59.94 because the limiter is a busy-wait on a millisecond clock that loses
  // every oversleep for good.
  //
  // (2) THE LIMITER IS ALSO A DETERMINISM LEAK. dfxvideo's frame SKIPPER
  // (fps.c FrameSkip, on by default here: pcsx_init stores UseFrameSkip=1 at
  // 0x8A954 = 567508) decides from gettimeofday whether the next frame's
  // primitives are DRAWN (gpu.c:1292 `if(bSkipNextFrame) primFunc=primTableSkip`).
  // So VRAM — guest state — depended on host time: exactly what rollback cannot
  // have (a re-simulated frame runs at a different wall time than the first
  // pass). Commit 0f6c3aa papered over it for lockstep by stepping the worker's
  // clock +1 s per gated step; that made every frame look "late", so the
  // skipper skipped up to MAXSKIP=120 flips in a row.
  //
  // THE FIX: after pcsx_init, turn dfxvideo's limiter AND skipper off
  // (UseFrameLimit=0 at 567504, UseFrameSkip=0 at 567508 — pcsx_init is their
  // only writer in this binary) and set `updated_display` (198800) to 0 before
  // every one_iter, so its head runs GPUupdateLace1() every vblank — Pete's
  // canonical no-skip path: the display updates on every vblank that drew
  // (gpu.c GPUupdateLace1). Then NOTHING in the vblank path reads a host
  // clock (the only other reads are FrameCap/FrameSkip/calcfps, now dead, and
  // an SPU diagnostic accumulator at 570568 nothing else reads), every
  // primitive is drawn, and the core is a pure function of (disc, pads, frame
  // index). The pace comes from ONE place: the page's 1.000x accumulator under
  // a gate, and paceSchedule() below when solo — at the DISC's rate, 59.94 Hz
  // for NTSC and 50 Hz for PAL (Config.PsxType), never the GPU plugin's guess.
  //
  // ⚠ These addresses belong to ONE wasm: the dist/wasmpsx_worker.wasm this
  // block ships with. ps1/ps1Wasm/build.sh rewrites them for every rebuild
  // (tools/reappend.mjs --repoint, from the new linker map; it fails on a
  // struct change), and coreSigOk() checks three string constants at their
  // addresses before anything is written; a different build fails the check,
  // logs it, and runs exactly as before (limiter and all).
  var CORE = {
    PsxType: 566591,         // u8  Config.PsxType (0 NTSC, 1 PAL) — misc.c CheckCdrom
    UseFrameSkip: 567908,    // u8  dfxvideo UseFrameSkip
    UseFrameLimit: 567904,   // u8  dfxvideo UseFrameLimit
    updatedDisplay: 198808,  // i32 fps.c updated_display (one_iter's Lace1 gate)
    palFlag: 569024,         // i32 dfxvideo PSXDisplay.PAL
    gpuStat: 567896,         // i32 dfxvideo lGPUstatusRet
    sbrk: 198784,            // u32 sbrk break (sbrk() in this build, func $78)
    sigs: [[4010, 'SetAutoFrameCap %d %f\n'], [3134, 'ES\u0000'], [3735, 'CD-ROM ID: %.9s\n']],
  };
  var TAKE = false, TAKE_WHY = 'not booted';
  var HZ_NTSC = 59.94, HZ_PAL = 50;
  var coreHz = HZ_NTSC, coreRegion = 'NTSC';
  function coreSigOk() {
    try {
      var u8 = Module.HEAPU8;
      for (var i = 0; i < CORE.sigs.length; i++) {
        var a = CORE.sigs[i][0], s = CORE.sigs[i][1];
        for (var k = 0; k < s.length; k++) if (u8[a + k] !== s.charCodeAt(k)) return false;
      }
      return true;
    } catch (e) { return false; }
  }
  function coreTakeover() {
    if (/[?&]corelimiter=1/.test(q)) { TAKE = false; TAKE_WHY = '?corelimiter=1 (the old dfxvideo limiter, for an A/B)'; }
    else if (!coreSigOk()) { TAKE = false; TAKE_WHY = 'this wasm is not the build the core addresses were read from'; }
    else {
      var u8 = Module.HEAPU8;
      u8[CORE.UseFrameSkip] = 0;
      u8[CORE.UseFrameLimit] = 0;
      coreRegion = u8[CORE.PsxType] ? 'PAL' : 'NTSC';
      coreHz = u8[CORE.PsxType] ? HZ_PAL : HZ_NTSC;
      TAKE = true; TAKE_WHY = 'ok';
    }
    try {
      postMessage({ cmd: 'print', txt: '[core] ' + (TAKE
        ? 'region ' + coreRegion + ' (Config.PsxType) -> ' + coreHz + ' Hz, one governor: the dfxvideo limiter and frame skipper are OFF'
        : 'governor takeover SKIPPED — ' + TAKE_WHY + '; the dfxvideo limiter paces this core') });
      postMessage({ cmd: 'coreRate', take: TAKE, why: TAKE_WHY, hz: coreHz, region: coreRegion });
    } catch (e) {}
  }
  var origInit = pcsx_init;
  pcsx_init = function () {
    var r = origInit.apply(this, arguments);
    try { coreTakeover(); } catch (e) { TAKE = false; TAKE_WHY = 'takeover threw: ' + e; }
    return r;
  };

  // One guest frame. With the takeover live, updated_display = 0 makes
  // one_iter's head run GPUupdateLace1 (the display update) every vblank; the
  // dfxvideo limiter that used to set it is off.
  var QUIET = false, QUIET_AUDIO = false, quietRenders = 0, quietAudio = 0;
  function runFrame() {
    if (TAKE) { Module.HEAP32[CORE.updatedDisplay >> 2] = 0; if (VMODE) followVideoMode(); }
    _one_iter();
  }

  // ══ THE VBLANK RATE FOLLOWS THE GPU'S VIDEO-MODE BIT, AS THE HARDWARE'S DOES ══
  // On a real PS1 the vertical timing is set by the GPU's video mode —
  // GP1(08h) bit 3, GPUSTAT bit 20: 0 = NTSC/60 Hz (263 lines), 1 = PAL/50 Hz
  // (314) — not by the region of the disc. PCSX instead times every frame from
  // Config.PsxType, which CheckCdrom sets once from the disc. Measured (rig
  // driving ps1.html solo, 300 s, netPeek of dfxvideo's PSXDisplay.PAL and
  // lGPUstatusRet): Monster Rancher 2 (SLUS-00917) runs with the PAL bit SET and
  // the display ON from 5-6 s after boot onward (GPUSTAT 0x5412200a; 239 of
  // 243 samples, the other 4 before its first GP1(08h)) — so the hardware runs
  // it at 50 vblanks/s, and pacing it at 59.94 was 1.2x too fast. It is not an
  // emulation artefact of PCSX's GetID answer ("PCSX", unlicensed): patching
  // that to a licensed "SCEA" left the bit set (81/85 samples).
  // So before every frame, while the display is on, Config.PsxType is set to
  // the GPU's mode: the core then times the frame as PAL (312 lines, VBlankStart
  // 256, the SPU interval) and the page and pacer run at 50 Hz. This is a pure
  // function of guest state (both bytes are in the snapshot), so a room and a
  // rollback switch at the same frame everywhere. Stated limit: the root
  // counter's line period (rcnts[3].target) is computed once at init from the
  // boot region, so a PAL frame on an NTSC-booted core is 312 x 2154 = 672,048
  // CPU cycles, 0.8% short of 677,376 — at 50 Hz the CPU runs at 0.992x, the
  // vblank rate at 1.000x. ?vmode=core keeps PCSX's boot-region timing.
  var VMODE = !/[?&]vmode=core/.test(q), vmodeSwitches = 0;
  function followVideoMode() {
    var u8 = Module.HEAPU8, h32 = Module.HEAP32;
    var pal = h32[CORE.palFlag >> 2] ? 1 : 0, on = !((h32[CORE.gpuStat >> 2] >>> 23) & 1);
    if (on && u8[CORE.PsxType] !== pal) { u8[CORE.PsxType] = pal; vmodeSwitches++; }
    var hz = u8[CORE.PsxType] ? HZ_PAL : HZ_NTSC;
    if (hz !== coreHz) {
      coreHz = hz; coreRegion = u8[CORE.PsxType] ? 'PAL' : 'NTSC';
      try {
        postMessage({ cmd: 'coreRate', take: TAKE, why: TAKE_WHY, hz: coreHz, region: coreRegion, by: 'GPU video mode', switches: vmodeSwitches });
        postMessage({ cmd: 'print', txt: '[core] GPU video mode -> ' + coreRegion + ' (GPUSTAT 0x' + (h32[CORE.gpuStat >> 2] >>> 0).toString(16) + '): ' + coreHz + ' Hz' });
      } catch (e) {}
    }
  }
  // Frames that are re-simulated (rollback) are not presented and their audio
  // is not played again: the host side of render/SendSound is skipped. Neither
  // writes guest memory — both only copy OUT of it — so this cannot fork state.
  var origRender = render;
  render = function () { if (QUIET) { quietRenders++; return; } return origRender.apply(this, arguments); };
  var origSendSound = SendSound;
  SendSound = function (ptr, lBytes) {
    if (QUIET_AUDIO) { quietAudio++; return; }
    if (AR) { arWrite(ptr, lBytes); return; }
    return origSendSound.apply(this, arguments);
  };

  // ── THE AUDIO RING (ps1.html "THE AUDIO SINK") ────────────────────────────
  // The page hands over a SharedArrayBuffer ('netAudioSab'); from then on every
  // batch the SPU mixes is written here and played by an AudioWorklet, with no
  // postMessage and no main-thread hop. Header (Int32): [0] write, [1] read
  // (stereo frames, wrapping), [2] frames produced, [3] frames dropped on a
  // full ring, [5] 1 while gated (the worklet trims its read rate only then),
  // [6]/[7] target fill in a room / solo, [8]/[9] the worklet's underruns and
  // frames consumed.
  // WHAT THE SPU MIXES IS UNCHANGED. Gated, it is still credited one frame of
  // 44.1 kHz per step (creditAudio) — a pure function of the frame index, so
  // the room's determinism argument does not move. Solo, the core's
  // buffered-bytes counter used to fall only when the page's SDL callback
  // replied 'soundBytes'; with the ring it is set from the ring's own fill
  // before each frame (arSoloCredit), so the SPU tops the ring up to the
  // target and production follows the sink exactly as it followed SDL.
  var AR = null;
  function arWrite(ptr, lBytes) {
    var h = AR.h, n = lBytes >> 2, w = Atomics.load(h, 0), r = Atomics.load(h, 1);
    h[5] = GATE ? 1 : 0;
    var free = AR.cap - ((w - r) | 0);
    if (n > free) { Atomics.add(h, 3, n - Math.max(0, free)); n = Math.max(0, free); }
    if (!n) return;
    var src = HEAP16, si = ptr >> 1, d = AR.d, m = AR.mask;
    for (var i = 0; i < n; i++) { var o = ((w + i) & m) << 1; d[o] = src[si]; d[o + 1] = src[si + 1]; si += 2; }
    Atomics.store(h, 0, (w + n) | 0);
    Atomics.add(h, 2, n);
  }
  function arSoloCredit() {
    if (!AR || GATE || typeof soundbuffer_ptr === 'undefined' || !soundbuffer_ptr) return;
    var h = AR.h, fill = (Atomics.load(h, 0) - Atomics.load(h, 1)) | 0;
    h[5] = 0;
    // SPUasync mixes while the counter is <= 22050 (dfsound/worker.c), adding
    // each batch to it — so it mixes (target - fill) bytes' worth this frame.
    Module.setValue(soundbuffer_ptr, 22050 - (h[7] - fill) * 4, 'i32');
  }

  // SOLO PACER — an absolute timeline at the disc's rate. Frame n starts at
  // t0 + n/Hz; a frame that finishes early waits for its slot. Falling behind
  // by more than one frame DROPS the debt instead of sprinting (CLAUDE.md gate
  // #9: the guest may run slower than hardware, never faster), so at most one
  // frame ever runs back-to-back to cover timer lateness.
  var paceDue = 0, paceCh = null, pacePending = false, paceDrops = 0, paceFrames = 0;
  if (typeof MessageChannel !== 'undefined') {
    paceCh = new MessageChannel();
    paceCh.port1.onmessage = function () { pacePending = false; pcsx_mainloop(); };
  }
  function paceKick() {
    if (pacePending) return;
    pacePending = true;
    if (paceCh) paceCh.port2.postMessage(0); else setTimeout(function () { pacePending = false; pcsx_mainloop(); }, 0);
  }
  function paceSchedule() {
    var now = performance.now(), period = 1000 / coreHz;
    paceFrames++;
    if (!paceDue) paceDue = now;
    paceDue += period;
    if (paceDue < now - period) { paceDue = now; paceDrops++; }
    var wait = paceDue - now;
    if (wait > 1) setTimeout(paceKick, wait); else paceKick();
  }

  // ── THE FAST EXACT SAVESTATE ──────────────────────────────────────────────
  // The whole guest lives in wasm linear memory: static data (psxRegs, GTE,
  // counters, SPU channels and RAM, dfxvideo state, CD-ROM state, memory card
  // images) and the sbrk heap (psxM/psxP/psxH/psxR, the LUTs, VRAM). The only
  // mutable wasm global is the stack pointer, which is at its base between
  // frames. So a snapshot of [1024, sbrk) taken BETWEEN one_iter calls IS the
  // machine; restoring it (plus the JS FS stream offsets — the ISO FILE's
  // buffer is in wasm memory but its fd offset lives in JS) resumes exactly.
  // No gzip, no freeze functions: one memcpy each way. This replaces the
  // 188-241 ms gzipped SaveState for rollback.
  var SNAP_LO = 1024;
  function snapTop() { return Module.HEAPU32[CORE.sbrk >> 2] >>> 0; }
  function fsPositions() {
    var out = [];
    try { var st = FS.streams; for (var i = 0; i < st.length; i++) if (st[i]) out.push(i, st[i].position); } catch (e) {}
    return out;
  }
  function fsRestore(p) {
    try { var st = FS.streams; for (var i = 0; i < p.length; i += 2) if (st[p[i]]) st[p[i]].position = p[i + 1]; } catch (e) {}
  }
  function snapSave(slot) {
    var hi = snapTop(), n = hi - SNAP_LO;
    if (!slot.buf || slot.buf.length < n) slot.buf = new Uint8Array(n + (256 << 10));
    slot.buf.set(Module.HEAPU8.subarray(SNAP_LO, hi));
    slot.len = n;
    slot.fs = fsPositions();
    return n;
  }
  function snapLoad(slot) {
    Module.HEAPU8.set(slot.buf.subarray(0, slot.len), SNAP_LO);
    fsRestore(slot.fs);
  }
  // A fingerprint of GUEST state: main RAM + the hardware page (found through
  // the core's own LUT, locateMem above) + VRAM + ALL static data. Host-side
  // bytes in the snapshot range (the stack's dead area, stdio buffers, the SPU
  // timing accumulator) are deliberately not hashed — they may legitimately
  // differ between two consoles that agree on every guest byte.
  //   ...static data = the CPU/GTE registers (psxRegs), the root counters, the
  // SPU (channels, registers, its 512 KB RAM), the CD-ROM controller, SIO and
  // both memory-card images (Mcd1Data/Mcd2Data) — so a divergence there is
  // caught at the next fingerprint, not when it reaches RAM. [1024, STATIC_END)
  // is .data+.bss; the 64 KB above it is the stack. Excluded, because they hold
  // HOST values that no guest path reads: the dfsound timing accumulator (two
  // f64 at 570568, written and read only in the flush that stamps them with
  // emscripten_get_now).
  //
  // ⚠ PER PAGE, SO A FINGERPRINT COSTS WHAT CHANGED. The old fingerprint ran
  // FNV over all ~4.2 MB of those regions every time: 6-14 ms in the rollback
  // probe — one step in every 60 paid it, and in a room that step is a spike
  // the frame pacing has to absorb. Now the regions are cut into their 4 KB
  // pages (HP: the pages, and each page's byte spans inside the regions); each
  // page has its own FNV, and the fingerprint is FNV over the page hashes in
  // page order. The undo ring keeps the page hashes of its shadow up to date
  // for exactly the pages a frame changed (it knows them), so a fingerprint of
  // the newest frame start is a 1,000-word loop, and one of a past frame
  // re-hashes only the pages that frame's undo logs hold. Same bytes covered;
  // a different (but just as deterministic) combining order than before, so
  // both peers and the reference core must run this build — they do: a room
  // compares fingerprints only between pages of the same build.
  var STATIC_END = 1130416;   // __heap_base (sbrk's initial value) minus the 64 KB stack
  var STATIC_SPANS = [1024, 570976, 570992, STATIC_END];
  var HP = null;
  function hashPlan() {
    if (HP) return HP;
    if (!memMapTried) { memMapTried = true; try { memMap = locateMem(); } catch (e) { memMap = null; } }
    if (!memMap) return null;
    var regs = [memMap.m, memMap.m + 0x200000, memMap.hw, memMap.hw + 0x10000];
    if (vram_ptr && (vram_ptr & 3) === 0) regs.push(vram_ptr, vram_ptr + 1024 * 512 * 2);
    for (var si = 0; si < STATIC_SPANS.length; si++) regs.push(STATIC_SPANS[si]);
    var by = new Map();
    for (var r = 0; r < regs.length; r += 2) {
      for (var a0 = regs[r]; a0 < regs[r + 1];) {
        var pg = a0 >>> 12, e0 = Math.min(regs[r + 1], (pg + 1) << 12);
        if (!by.has(pg)) by.set(pg, []);
        by.get(pg).push(a0, e0);
        a0 = e0;
      }
    }
    var pages = Array.from(by.keys()).sort(function (x, y) { return x - y; });
    var spans = [], idx = new Int32Array(pages[pages.length - 1] + 1).fill(-1);
    for (var k = 0; k < pages.length; k++) {
      var sp = by.get(pages[k]), pairs = [];
      for (var t = 0; t < sp.length; t += 2) pairs.push([sp[t], sp[t + 1]]);
      pairs.sort(function (x, y) { return x[0] - y[0]; });
      var flat = [];
      for (var t2 = 0; t2 < pairs.length; t2++) flat.push(pairs[t2][0], pairs[t2][1]);
      spans.push(flat); idx[pages[k]] = k;
    }
    HP = { pages: pages, spans: spans, idx: idx };
    return HP;
  }
  // FNV of page HP.pages[k]'s hashed bytes. `src` is indexed by absolute word
  // address minus `off` (0 for the heap or the shadow; page << 10 for a
  // page-sized undo buffer).
  function pageHash(src, off, k) {
    var sp = HP.spans[k], h = 0x811c9dc5 | 0;
    for (var t = 0; t < sp.length; t += 2) for (var i = (sp[t] >> 2) - off, e = (sp[t + 1] >> 2) - off; i < e; i++) h = Math.imul(h ^ src[i], 16777619);
    return h;
  }
  function combine(ph, ov) {
    var h = 0x811c9dc5 | 0, n = HP.pages.length;
    for (var k = 0; k < n; k++) {
      var o = ov ? ov.get(HP.pages[k]) : undefined;
      h = Math.imul(h ^ (o ? pageHash(o, HP.pages[k] << 10, k) : ph[k]), 16777619);
    }
    return h >>> 0;
  }
  function allPageHashes(src32) {
    var ph = new Int32Array(HP.pages.length);
    for (var k = 0; k < ph.length; k++) ph[k] = pageHash(src32, 0, k);
    return ph;
  }
  function liveHash() {
    if (!hashPlan()) return null;
    return combine(allPageHashes(new Int32Array(Module.HEAPU8.buffer)), null);
  }

  // ══ THE ROLLBACK RING IS AN UNDO LOG, NOT A STACK OF SNAPSHOTS ═════════════
  // It used to keep one full 6.86 MB copy of [1024, sbrk) per frame it could
  // rewind to: 12 slots (~82 MB) at the starting window, 24 (~157 MB) at
  // 100 ms one way + 2% loss — a phone risk. But a frame changes very little
  // of that range: measured on Monster Rancher 2 (memmap rig, 4 KB pages),
  // 18 of 1,676 pages per frame, and 85 of 105 64 KB blocks never changed in
  // 2,000 frames. So the ring now holds:
  //   * ONE shadow copy of the machine at the start of the newest frame
  //     (UR.frame) — always byte-equal to live memory between steps, and
  //   * per frame j, an UNDO LOG: the old (start-of-j) contents of exactly the
  //     4 KB pages frame j changed, plus the JS FS stream offsets at start-of-j.
  // Saving the start of frame j+1 = compare live against the shadow page by
  // page, keep the shadow's old copy of every page that differs, copy the new
  // one in. Rewinding to the start of frame k = apply the logs of frames
  // UR.frame-1 ... k (newest first) to the shadow, then copy the shadow over
  // live memory — the WHOLE range, not just the logged pages, so any stray
  // write since the last save is reverted too, exactly as the old full-slot
  // load did. A fingerprint of a past frame reads the shadow through the logs
  // (oldest log wins per page), never touching live memory.
  // Exactness is unchanged in kind: every byte of [1024, top) is either in the
  // shadow or in a log, and a page is only ever left out of a log when it is
  // byte-identical to the shadow. Bytes above sbrk (free memory) behave as
  // they did with full slots: a heap that grows extends the shadow from live.
  var PAGE = 4096, PAGE_W = 1024;
  var UR = { stepCmpMs: 0, stepPages: 0, sh: null, sh32: null, top: 0, cap: 0, list: 0, mem: null, simd: null, frame: -1, fs: [], logs: new Map(), pool: [], poolCap: 1024,
             saves: 0, pages: 0, maxPages: 0, logPages: 0, cmpMs: 0, oldest: -1, maxLogPages: 0, check: /[?&]urcheck=1/.test(q), checkFails: 0, how: 'js',
             checkMiss: 0, checkMissAt: [], trackSaves: 0, trackPages: 0, fullBytes: 0 };
  // THE COMPARE IS THE COST. Reading 6.86 MB twice per frame in JS is ~1.7 ms
  // (node, Int32Array, early exit per page) — against 0.5 ms for the old
  // full memcpy. So when the browser can, the shadow lives in its own
  // WebAssembly.Memory and a 244-byte module compares it against the core's
  // memory with SIMD (two memories: core imported as memory 0, shadow as 1):
  // 0.45 ms for the same range. CMP_WASM is exactly this source, assembled with
  // binaryen: wasm-as --enable-simd --enable-multimemory cmp.wat -o cmp.wasm
  //   cmp(lo, top, list) -> n: for each 4 KB page of [lo, top) that differs
  //   between core and shadow, store its page number at shadow[list + 4i].
  //   (module
  //     (import "e" "core" (memory $core 1))
  //     (import "e" "own" (memory $own 1))
  //     (func (export "cmp") (param $lo i32) (param $top i32) (param $list i32) (result i32)
  //       (local $p i32) (local $a i32) (local $e i32) (local $n i32)
  //       (local.set $a (local.get $lo))
  //       (block $done
  //         (loop $pages
  //           (br_if $done (i32.ge_u (local.get $a) (local.get $top)))
  //           (local.set $e (i32.add (i32.and (local.get $a) (i32.const -4096)) (i32.const 4096)))
  //           (if (i32.gt_u (local.get $e) (local.get $top)) (then (local.set $e (local.get $top))))
  //           (local.set $p (local.get $a))
  //           (block $diff
  //             (block $same
  //               (loop $words
  //                 (br_if $same (i32.ge_u (local.get $p) (local.get $e)))
  //                 (br_if $diff (v128.any_true (v128.or
  //                    (v128.or (v128.xor (v128.load $core (local.get $p)) (v128.load $own (local.get $p)))
  //                             (v128.xor (v128.load $core offset=16 (local.get $p)) (v128.load $own offset=16 (local.get $p))))
  //                    (v128.or (v128.xor (v128.load $core offset=32 (local.get $p)) (v128.load $own offset=32 (local.get $p)))
  //                             (v128.xor (v128.load $core offset=48 (local.get $p)) (v128.load $own offset=48 (local.get $p)))))))
  //                 (local.set $p (i32.add (local.get $p) (i32.const 64)))
  //                 (br $words)))
  //             (local.set $a (local.get $e))
  //             (br $pages))
  //           (i32.store $own (i32.add (local.get $list) (i32.shl (local.get $n) (i32.const 2))) (i32.shr_u (local.get $a) (i32.const 12)))
  //           (local.set $n (i32.add (local.get $n) (i32.const 1)))
  //           (local.set $a (local.get $e))
  //           (br $pages)))
  //       (local.get $n))
  //   ) Anything that cannot instantiate it (no SIMD, no
  // multi-memory) uses the JS loop, which gives the same answer; ?urcheck=1
  // runs both on every save and counts disagreements (urcheck.fails).
  var CMP_WASM = 'AGFzbQEAAAABCAFgA39/fwF/AhQCAWUEY29yZQIAAQFlA293bgIAAQMCAQAHBwEDY21wAAAKvAEBuQEBBH8gACEEAkADQCAEIAFPDQEgBEGAYHFBgCBqIQUgBSABSwRAIAEhBQsgBCEDAkACQANAIAMgBU8NASAD/QAEACAD/QBEAQD9USAD/QAEECAD/QBEARD9Uf1QIAP9AAQgIAP9AEQBIP1RIAP9AAQwIAP9AEQBMP1R/VD9UP1TDQIgA0HAAGohAwwACwALIAUhBAwBCyACIAZBAnRqIARBDHY2QgEAIAZBAWohBiAFIQQMAAsACyAGCw==';
  function urSimdInit(cap) {
    if (/[?&]urcmp=js/.test(q)) return null;
    try {
      var bin = atob(CMP_WASM), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      var mem = new WebAssembly.Memory({ initial: Math.ceil((cap + 65536) / 65536) });
      var inst = new WebAssembly.Instance(new WebAssembly.Module(u), { e: { core: wasmMemory, own: mem } });
      return { mem: mem, cmp: inst.exports.cmp };
    } catch (e) { return null; }
  }
  function urViews() {
    if (UR.mem) { UR.sh = new Uint8Array(UR.mem.buffer, 0, UR.cap); UR.sh32 = new Int32Array(UR.mem.buffer, 0, UR.cap >> 2); }
    else UR.sh32 = new Int32Array(UR.sh.buffer, 0, UR.cap >> 2);
  }
  function urTopNow() {
    var t = (snapTop() + PAGE - 1) & ~(PAGE - 1), L = Module.HEAPU8.length;
    return t < L ? t : L;
  }
  // ⚠ A PAGE BUFFER IS ONE VIEW OF A SHARED CHUNK, NEVER ITS OWN ALLOCATION.
  // A fresh Uint8Array(4096) per logged page is a zeroed backing-store
  // allocation each — measured (node, 277 pages, MR2 frame 401's first picture
  // upload): 1.1-2.7 ms against 0.24-0.45 ms from the pool, and in a room that
  // frame's save was 7.1-8.6 ms on both consoles. So the pool is filled in
  // chunks (one ArrayBuffer, many views), before a save needs them: at every
  // (re-)arm and whenever a save would empty it.
  var POOL_CHUNK = 256, POOL_ARM = 384;
  function urPoolFill(n) {
    n = Math.max(n | 0, POOL_CHUNK);
    var ab = new ArrayBuffer(n * PAGE);
    for (var i = 0; i < n; i++) UR.pool.push(new Uint8Array(ab, i * PAGE, PAGE));
  }
  function urRelease(L) {
    for (var q = 0; q < L.bufs.length; q++) if (UR.pool.length < UR.poolCap) UR.pool.push(L.bufs[q]);
    UR.logPages -= L.pages.length;
  }
  function urExtend(top) {
    if (top <= UR.top) return;
    if (top > UR.cap) {
      var cap = top + (1 << 20);
      if (UR.simd === null && !UR.sh) { UR.simd = urSimdInit(cap); UR.how = UR.simd ? 'simd' : 'js'; }
      if (UR.simd) {
        UR.mem = UR.simd.mem;
        var need = Math.ceil((cap + 65536) / 65536) - (UR.mem.buffer.byteLength >> 16);
        if (need > 0) UR.mem.grow(need);
        UR.cap = cap; UR.list = cap; urViews();
      } else {
        UR.simd = false;
        var nb = new Uint8Array(cap);
        if (UR.sh) nb.set(UR.sh.subarray(0, UR.top));
        UR.sh = nb; UR.cap = cap; urViews();
      }
    }
    UR.sh.set(Module.HEAPU8.subarray(UR.top, top), UR.top);
    UR.top = top;
  }
  function urInit(k) {
    UR.logs.forEach(urRelease); UR.logs.clear(); UR.oldest = -1;
    urTrackPlan();
    UR.top = 0; urExtend(urTopNow());
    urTrackClear();
    UR.frame = k; UR.fs = fsPositions();
    if (UR.pool.length < POOL_ARM) urPoolFill(POOL_ARM - UR.pool.length);
    UR.ph = hashPlan() ? allPageHashes(UR.sh32) : null;
    UR.phStale = UR.ph ? new Uint8Array(UR.ph.length) : null; UR.phList = [];
  }
  // A changed shadow page's hash is recomputed when a fingerprint is next taken,
  // not at every save (2026-10-08): a page a game rewrites every frame was
  // re-hashed up to 60 times per fingerprint. Same bytes, same order, same
  // result — only when the work happens moves.
  function urRehash(p) { var k; if (UR.ph && p < HP.idx.length && (k = HP.idx[p]) >= 0 && !UR.phStale[k]) { UR.phStale[k] = 1; UR.phList.push(k); } }
  function urRehashFlush() {
    for (var i = 0; i < UR.phList.length; i++) { var k = UR.phList[i]; UR.ph[k] = pageHash(UR.sh32, 0, k); UR.phStale[k] = 0; }
    UR.phList.length = 0;
  }
  // ══ THE CORE TRACKS ITS OWN WRITES (2026-10-08) ═════════════════════════
  // THE COMPARE IS THE COST, above, was still ~1.2 ms of a ~5 ms Monster
  // Rancher 2 room step — 20% of the worker's CPU, for 6.86 MB read twice a
  // frame. Most of those bytes are six guest memories with a handful of
  // writers each (main RAM, the BIOS image, the two memory LUTs, VRAM and its
  // margins, SPU RAM, both memory cards: 5.6 MB of the 6.86), so the core now
  // MARKS every 4 KB page it writes inside them in a page table
  // (pcsx-wasm-src/libpcsxcore/urdirty.h — every write path, and a whole-span
  // mark wherever a span is overwritten wholesale) and a save compares:
  //   * every page OUTSIDE those spans, in full, exactly as before (static
  //     data, the stack, the hardware page, every other heap byte), and
  //   * only the MARKED pages inside them (a marked page that did not really
  //     change compares equal and is not logged),
  // then clears the table and bumps its generation word (a writer may skip
  // re-marking a range it marked in the same generation). The table and its
  // span list are one malloc'd block that is never compared, logged, hashed or
  // restored — a restore copies the shadow around it. Nothing else changes:
  // the logs, the shadow and every fingerprint are the same bytes as before.
  // ?urcheck=1 runs the full compare too on every save and counts the pages it
  // finds that the tracked one did not (urcheck.miss, first few in missAt);
  // tools/ps1_rollback_probe.mjs requires 0. ?urtrack=0 compares everything.
  var URT = null;
  function urTrackPlan() {
    URT = null;
    if (/[?&]urtrack=0\b/.test(q) || typeof _ur_info !== 'function') return;
    var ip = _ur_info() >>> 0;
    if (!ip) return;
    var h32 = Module.HEAPU32, w = ip >> 2, tab = h32[w] >>> 0, nsp = h32[w + 1] >>> 0, bsz = h32[w + 2] >>> 0;
    if (!tab || (tab & (PAGE - 1)) || ip !== tab + 65536) return;
    var ex = [], names = ['ram', 'bios', 'rlut', 'wlut', 'vram', 'spu', 'mcd1', 'mcd2', 'par'];
    for (var i = 0; i < nsp; i++) {
      var lo = h32[w + 4 + 3 * i] >>> 0, hi = h32[w + 5 + 3 * i] >>> 0;
      if (!h32[w + 6 + 3 * i] || hi <= lo) continue;
      var p0 = (lo + PAGE - 1) >>> 12, p1 = hi >>> 12;   // whole pages only: a page shared with an untracked byte stays fully compared
      if (p1 > p0) ex.push([p0, p1, names[i] || ('span' + i)]);
    }
    var b0 = tab >>> 12, b1 = (tab + bsz + PAGE - 1) >>> 12;
    for (var e = 0; e < ex.length; e++) if (ex[e][0] < b1 && b0 < ex[e][1]) return;   // overlap: refuse, compare everything
    ex.sort(function (x, y) { return x[0] - y[0]; });
    var trk = [];
    for (var t = 0; t < ex.length; t++) {
      if (t && ex[t][0] < ex[t - 1][1]) return;   // spans overlap: refuse
      trk.push(ex[t][0], ex[t][1]);
    }
    var all = ex.concat([[b0, b1, 'table']]).sort(function (x, y) { return x[0] - y[0]; });
    var full = [], a0 = 1024;
    for (var k = 0; k < all.length; k++) { var s0 = all[k][0] << 12; if (s0 > a0) full.push(a0, s0); if ((all[k][1] << 12) > a0) a0 = all[k][1] << 12; }
    full.push(a0, 0x7ffff000);
    URT = { tab: tab, genW: w + 3, b0: b0 << 12, b1: b1 << 12, trk: trk, full: full, spans: ex };
  }
  function urTrackClear() {
    if (!URT) return;
    Module.HEAPU8.fill(0, URT.tab, URT.tab + 65536);
    var h32 = Module.HEAPU32; h32[URT.genW] = (h32[URT.genW] + 1) >>> 0;
  }
  // The changed pages of [1024, lim) by the plan above: full ranges + marked pages.
  function urDiffTracked(lim) {
    var fl = Module.HEAPU8, tab = URT.tab, F = URT.full, T = URT.trk, pl = lim >>> 12, out, i, b;
    if (UR.simd) {
      var n = 0, L = UR.list, cmp = UR.simd.cmp;
      for (i = 0; i < F.length; i += 2) { if (F[i] >= lim) break; b = F[i + 1] < lim ? F[i + 1] : lim; n += cmp(F[i], b, L + 4 * n); UR.fullBytes += b - F[i]; }
      for (i = 0; i < T.length; i += 2) {
        var p = T[i], e = T[i + 1] < pl ? T[i + 1] : pl;
        while (p < e) {
          if (!fl[tab + p]) { p++; continue; }
          var r0 = p; while (p < e && fl[tab + p]) p++;
          n += cmp(r0 << 12, p << 12, L + 4 * n); UR.trackPages += p - r0;
        }
      }
      out = Array.prototype.slice.call(new Int32Array(UR.mem.buffer, UR.list, n));
    } else {
      var live32 = new Int32Array(Module.HEAPU8.buffer);
      out = [];
      for (i = 0; i < F.length; i += 2) { if (F[i] >= lim) break; b = F[i + 1] < lim ? F[i + 1] : lim; urDiffJsRange(live32, F[i] >> 2, b >> 2, out); UR.fullBytes += b - F[i]; }
      for (i = 0; i < T.length; i += 2) {
        var q0 = T[i], e2 = T[i + 1] < pl ? T[i + 1] : pl;
        for (; q0 < e2; q0++) if (fl[tab + q0]) { urDiffJsRange(live32, q0 << 10, (q0 + 1) << 10, out); UR.trackPages++; }
      }
    }
    UR.trackSaves++;
    return out;
  }
  // urDiffJs over word range [w0, w1) (page aligned except a start of 256 = byte 1024)
  function urDiffJsRange(live32, w0, w1, out) {
    var sh32 = UR.sh32;
    for (var p = w0 >> 10; (p << 10) < w1; p++) {
      var i = p << 10 > w0 ? p << 10 : w0, e = (p + 1) << 10;
      if (e > w1) e = w1;
      for (; i < e; i++) if (live32[i] !== sh32[i]) break;
      if (i < e) out.push(p);
    }
    return out;
  }
  function urDiffJs(live32, lim, out) {
    var sh32 = UR.sh32;
    for (var p = 0; (p << 10) < lim; p++) {
      var i = p ? p << 10 : 256, e = (p + 1) << 10;
      if (e > lim) e = lim;
      for (; i < e; i++) if (live32[i] !== sh32[i]) break;
      if (i < e) out.push(p);
    }
    return out;
  }
  // Live memory is the start of frame UR.frame + span (1 unless re-simulated
  // frames were run without a save in between, see THE RE-SIMULATION SAVES
  // ONLY WHAT A ROLLBACK CAN NAME): log those frames' changes as ONE undo log
  // {from: UR.frame, to: UR.frame + span} and advance the shadow.
  function urCommit(span) {
    span = span > 1 ? span | 0 : 1;
    var t0 = performance.now(), heap = Module.HEAPU8, top = urTopNow();
    var lim = top < UR.top ? top : UR.top, pages;
    if (URT) {
      pages = urDiffTracked(lim);
      if (UR.check) {
        // the full compare, as it was before the core tracked its writes (minus the table itself)
        var fp = urDiffJs(new Int32Array(heap.buffer), lim >> 2, []), have = new Set(pages);
        for (var c = 0; c < fp.length; c++) {
          var pc = fp[c];
          if (pc << 12 >= URT.b0 && pc << 12 < URT.b1) continue;
          if (!have.has(pc)) {
            UR.checkMiss++;
            if (UR.checkMissAt.length < 8) { var nm = '?'; for (var si = 0; si < URT.spans.length; si++) if (pc >= URT.spans[si][0] && pc < URT.spans[si][1]) nm = URT.spans[si][2]; UR.checkMissAt.push({ frame: UR.frame, page: pc, span: nm }); }
          }
        }
      }
      urTrackClear();
    } else if (UR.simd) {
      var n = UR.simd.cmp(1024, lim, UR.list);
      pages = Array.prototype.slice.call(new Int32Array(UR.mem.buffer, UR.list, n));
      if (UR.check) { var jp = urDiffJs(new Int32Array(heap.buffer), lim >> 2, []); if (jp.join() !== pages.join()) UR.checkFails++; }
    } else pages = urDiffJs(new Int32Array(heap.buffer), lim >> 2, []);
    UR.stepCmpMs += performance.now() - t0; UR.stepPages += pages.length;
    if (UR.pool.length < pages.length) urPoolFill(pages.length - UR.pool.length);
    var sh = UR.sh, bufs = [];
    for (var k = 0; k < pages.length; k++) {
      var p = pages[k], o = p << 12, b = UR.pool.pop() || new Uint8Array(PAGE);
      b.set(sh.subarray(o, o + PAGE));
      var s0 = p ? o : 1024, e0 = o + PAGE < lim ? o + PAGE : lim;
      sh.set(heap.subarray(s0, e0), s0);
      bufs.push(b);
      urRehash(p);
    }
    urExtend(top);
    UR.logs.set(UR.frame, { pages: pages, bufs: bufs, fs: UR.fs, to: UR.frame + span });
    if (UR.oldest < 0) UR.oldest = UR.frame;
    UR.logPages += pages.length;
    UR.frame += span; UR.fs = fsPositions();
    urTrim();
    UR.saves++; UR.pages += pages.length; if (pages.length > UR.maxPages) UR.maxPages = pages.length;
    if (UR.logPages > UR.maxLogPages) UR.maxLogPages = UR.logPages;
    UR.cmpMs += performance.now() - t0;
  }
  // Logs are contiguous: a chain from UR.oldest to UR.frame, keyed by the
  // frame start each one restores (L.to = the start it undoes). Drop the oldest while
  // (a) it is older than the ring's reach (RB.n frames), or (b) the logs are
  // over the device budget (RB.budget) AND it is older than RB.keepFrom, the
  // earliest frame start the engine could still roll back to. (b) never
  // drops a frame a rollback can name; the page stops running ahead instead
  // (ps1.html lsFeedOne, "THE RING'S MEMORY BUDGET").
  function urTrim() {
    var lo = UR.frame - Math.max(2, RB.n);
    while (UR.oldest >= 0 && UR.oldest < UR.frame) {
      var old = UR.oldest < lo || (RB.budget > 0 && UR.logPages * PAGE > RB.budget && RB.keepFrom >= 0 && UR.oldest < RB.keepFrom);
      if (!old) break;
      var L = UR.logs.get(UR.oldest);
      if (L) { urRelease(L); UR.logs.delete(UR.oldest); UR.oldest = L.to; } else UR.oldest++;
    }
    if (UR.oldest >= UR.frame) UR.oldest = -1;
  }
  // The logs from frame start k up to UR.frame, oldest first; null if k is not
  // a frame start the chain holds (out of reach, or inside a merged log).
  function urChain(k) {
    if (k > UR.frame || k < 0) return null;
    var out = [];
    for (var c = k; c < UR.frame;) { var L = UR.logs.get(c); if (!L) return null; out.push(c); c = L.to; }
    return out;
  }
  function urCanReach(k) { return urChain(k) !== null; }
  function urRestore(k) {
    var fs = UR.fs, ch = urChain(k);
    for (var i = ch.length - 1; i >= 0; i--) {
      var L = UR.logs.get(ch[i]);
      for (var q = 0; q < L.pages.length; q++) { UR.sh.set(L.bufs[q], L.pages[q] << 12); urRehash(L.pages[q]); }
      fs = L.fs;
      urRelease(L); UR.logs.delete(ch[i]);
    }
    if (UR.oldest >= k) UR.oldest = -1;
    if (URT && URT.b0 < UR.top) {
      // around the tracking table: it is host state, and its generation must only grow
      Module.HEAPU8.set(UR.sh.subarray(1024, URT.b0), 1024);
      if (URT.b1 < UR.top) Module.HEAPU8.set(UR.sh.subarray(URT.b1, UR.top), URT.b1);
    } else Module.HEAPU8.set(UR.sh.subarray(1024, UR.top), 1024);
    urTrackClear();
    fsRestore(fs);
    UR.frame = k; UR.fs = fs;
  }
  function urHashAt(k) {
    var ch = urChain(k);
    if (!ch) return null;
    var ov = null;
    if (k < UR.frame) {
      ov = new Map();
      for (var j = ch.length - 1; j >= 0; j--) {
        var L = UR.logs.get(ch[j]);
        for (var q = 0; q < L.pages.length; q++) ov.set(L.pages[q], new Int32Array(L.bufs[q].buffer, L.bufs[q].byteOffset, PAGE_W));
      }
    }
    if (UR.ph) urRehashFlush();
    return UR.ph ? combine(UR.ph, ov) : null;
  }
  function urBytes() { return UR.cap + (UR.logPages + UR.pool.length) * PAGE; }

  var RB = { n: 0, live: -1, steps: 0, resim: 0, saveMs: 0, runMs: 0, loadMs: 0, maxStepMs: 0, lastBytes: 0,
             maxRunMs: 0, maxSaveMs: 0, maxLoadMs: 0, maxHashMs: 0, hist: [0, 0, 0, 0, 0, 0], budget: 0, keepFrom: -1 };   // step ms: <8, <12, <17, <33, <67, >=67
  var RB_MERGE = !/[?&]rbmerge=0\b/.test(q);
  function rbGrow(n) { n = Math.max(2, n | 0); if (n > RB.n) RB.n = n; }
  function rbSaveFrame(k, n) {
    var t = performance.now();
    n = n > 1 ? n | 0 : 1;
    if (UR.sh && UR.frame + n === k) urCommit(n); else urInit(k);
    t = performance.now() - t;
    RB.saveMs += t; if (t > RB.maxSaveMs) RB.maxSaveMs = t;
    RB.lastBytes = urBytes();
  }
  function latchPads(states) {
    if (states && typeof padStatus1 !== 'undefined' && padStatus1) Module.HEAPU8.set(new Uint8Array(states), padStatus1);
  }

  // RIG-ONLY: a SLOWER DEVICE, on demand ('netSlow' {r}; inert until sent).
  // The CDP CPU throttle never reaches a worker, so a test that needs one
  // console's emulator to be r times slower — and then to recover — asks for
  // it here: every gated frame's work (netStep, netRbStep) is followed, INSIDE
  // the time those report, by (r-1) times its own duration of busy-waiting.
  // The guest computes exactly what it did; only the host's clock moves.
  // tools/ps1_netplay_test.mjs --slow-guest R --slow-until S.
  var SLOW_R = 1;
  function slowBurn(t0) {
    if (SLOW_R <= 1) return;
    var now = performance.now(), until = now + (now - t0) * (SLOW_R - 1);
    while (performance.now() < until) {}
  }
  var origMain = main_onmessage;
  main_onmessage = function (event) {
    var data = event.data;
    switch (data && data.cmd) {

      // Run exactly `count` guest frames (default 1) with `states` latched into
      // BOTH controller ports first, then report. Input is therefore a function
      // of the emulated frame index, never of wall time.
      case 'netStep': {
        var n = (data.count | 0) || 1;
        try {
          // With the governor takeover the core reads no host clock at all, so
          // the +1 s clock step (0f6c3aa) has nothing left to defeat.
          if (!TAKE) netClockJump();
          if (data.states && typeof padStatus1 !== 'undefined' && padStatus1) {
            Module.HEAPU8.set(new Uint8Array(data.states), padStatus1);
          }
          // A hidden frame (a returning player catching up in an input-delay
          // room) is neither presented nor heard.
          QUIET = QUIET_AUDIO = !!data.hidden;
          // ⚠ THE SAVE COST GOES STALE IN A DELAY STRETCH (n64 room_core.js hit
          // it: the room sat in delay for 55 s on the slow period's saves). With
          // `remeasure` (ps1.html, every RB_REMEASURE_MS of a delay stretch of a
          // room whose ring was armed) this frame is bracketed by ONE real undo
          // save exactly as a rollback step takes it: the shadow is re-taken
          // before the frame (untimed — the ring is stale anyway and is re-armed
          // by netRbInit before the next rollback frame), then the frame's
          // commit is timed. Nothing the guest can see: the undo ring is host
          // memory outside [SNAP_LO, sbrk).
          var remeasure = !!data.remeasure && TAKE && n === 1 && RB.live >= 0, svMs = -1;
          if (remeasure) urInit(data.frame | 0);
          var tr0 = performance.now();
          try { for (var i = 0; i < n; i++) { runFrame(); creditAudio(); } } finally { QUIET = QUIET_AUDIO = false; }
          slowBurn(tr0);
          var runMs = (performance.now() - tr0) / n;
          if (remeasure) {
            var ts0 = performance.now(); urCommit(); svMs = performance.now() - ts0;
            UR.logs.forEach(urRelease); UR.logs.clear(); UR.oldest = -1;
            RB.remeasures = (RB.remeasures | 0) + 1;
          }
          // What one frame's run cost, so a page in an input-delay room can keep
          // its rollback step estimate current (ps1.html rbOnDelayFrame) — the
          // capacity gate takes a room back to rollback only on a fresh one.
          postMessage({ cmd: 'netFrame', frame: data.frame, ran: n, runMs: runMs, sv: svMs });
        } catch (e) {
          postMessage({ cmd: 'netFrame', frame: data.frame, ran: 0, err: String(e) });
        }
        break;
      }

      // Under the gate the PAGE's drain credit is ignored: it arrives on the
      // page's wall clock, which is exactly the per-peer input creditAudio()
      // exists to keep out of the SPU (it used to land between steps and could
      // drive the counter negative).
      case 'soundBytes': {
        if (GATE || AR) break;
        return origMain(event);
      }

      // ── ROLLBACK ────────────────────────────────────────────────────────
      // 'netRbInit' {frame, ring}: the room's frame `frame` is about to be the
      // first this core runs; keep its start state. Must arrive before any
      // netRbStep, which message order guarantees.
      case 'netRbInit': {
        try {
          if (!TAKE) throw new Error('rollback needs the governor takeover (' + TAKE_WHY + ')');
          rbGrow(data.ring | 0);
          RB.budget = +data.budget > 0 ? +data.budget : 0;
          RB.live = data.frame | 0;
          var ti = performance.now(); urInit(RB.live); RB.saveMs += performance.now() - ti; RB.lastBytes = urBytes();
          postMessage({ cmd: 'netRbReady', ok: true, frame: RB.live, ring: RB.n, bytes: RB.lastBytes });
        } catch (e) {
          postMessage({ cmd: 'netRbReady', ok: false, err: String((e && e.message) || e) });
        }
        break;
      }
      // 'netRbStep' {frame, states, resim:[{frame, states}], hidden, hash:[k], ring}
      //   resim:  frames to RE-SIMULATE first (from the earliest wrong one up
      //           to frame-1): load the start of resim[0], then for each: latch
      //           its pads, run it unpresented, keep the start of the next.
      //   frame:  the present frame (presented unless `hidden`), then keep the
      //           start of frame+1.
      //   hash:   confirmed frames k whose END state (= slot k+1) to fingerprint.
      // The live state after the last frame IS the saved start of the next, so
      // no load happens unless there is something to re-simulate.
      case 'netRbStep': {
        var t0 = performance.now(), err = null, resimRan = 0, hashes = [], sv0 = RB.saveMs, ld = 0, rr = 0, tp = 0, th = 0, pend = 0;
        var hb0 = Module.HEAPU8.length, top0 = UR.top, cap0 = UR.cap; UR.stepCmpMs = 0; UR.stepPages = 0;
        try {
          if (data.ring) rbGrow(data.ring | 0);
          if (typeof data.keepFrom === 'number') {
            // ...and never past a fingerprint this same step still has to take.
            var kf = data.keepFrom | 0, hq = data.hash || [];
            for (var hq0 = 0; hq0 < hq.length; hq0++) if ((hq[hq0] | 0) + 1 < kf) kf = (hq[hq0] | 0) + 1;
            RB.keepFrom = kf;
          }
          var rs = data.resim || [];
          if (rs.length) {
            if (!urCanReach(rs[0].frame | 0)) throw new Error('no savestate for frame ' + rs[0].frame + ' (ring ' + RB.n + ')');
            var tl = performance.now();
            urRestore(rs[0].frame | 0);
            tl = performance.now() - tl; ld = tl;
            RB.loadMs += tl; if (tl > RB.maxLoadMs) RB.maxLoadMs = tl;
            QUIET = true; QUIET_AUDIO = true;
            try {
              for (var ri = 0; ri < rs.length; ri++) {
                latchPads(rs[ri].states);
                var tr = performance.now();
                runFrame(); creditAudio();
                tr = performance.now() - tr; rr += tr;
                RB.runMs += tr;
                // ══ THE RE-SIMULATION SAVES ONLY WHAT A ROLLBACK CAN NAME ══════
                // Every re-simulated frame used to keep the start of the next
                // one: a whole-range compare (urCommit, 1.4-3.5 ms in a room)
                // per frame, so a 2-frame correction paid three saves. But a
                // frame start BEFORE keepFrom (the engine's frontier + 1: every
                // port's input is final there, and this step's fingerprints are
                // already folded in above) can never be rolled back to or hashed
                // again — urTrim drops exactly those first under budget. So a
                // start before keepFrom is not saved: the frames are merged into
                // the next save's undo log ({from, to}, one compare). Exactness
                // is unchanged — live memory is never touched, and every start
                // a rollback or fingerprint can still name keeps its own log.
                // ?rbmerge=0 saves every start, as before (the A/B arm).
                var nx = (rs[ri].frame | 0) + 1;
                if (RB_MERGE && RB.keepFrom >= 0 && nx < RB.keepFrom && UR.sh && UR.frame + pend + 1 === nx) { pend++; RB.merged = (RB.merged | 0) + 1; }
                else { rbSaveFrame(nx, pend + 1); pend = 0; }
                resimRan++;
              }
            } finally { QUIET = false; QUIET_AUDIO = false; }
            RB.resim += resimRan;
          } else if (UR.frame !== (data.frame | 0)) {
            throw new Error('the ring does not hold the start of frame ' + data.frame);
          }
          latchPads(data.states);
          // A HIDDEN catch-up frame (the room clock says this console is behind)
          // is not PRESENTED — no fast-forward on screen. Its audio plays unless
          // the page says `quietAudio`: the page mutes exactly the hidden frames
          // that run AHEAD of this console's own wall-clock timeline (a late
          // starter being moved up to the room), and plays the ones that repay
          // its own lost frames, so the sink gets one frame of sound per frame
          // of wall clock (ps1.html rbTimelineTick). Re-simulated frames above
          // are repeats, so they always stay quiet.
          QUIET = !!data.hidden; QUIET_AUDIO = !!data.quietAudio;
          tp = performance.now();
          try { runFrame(); creditAudio(); } finally { QUIET = false; QUIET_AUDIO = false; }
          tp = performance.now() - tp;
          RB.runMs += tp; if (tp > RB.maxRunMs) RB.maxRunMs = tp;
          rbSaveFrame((data.frame | 0) + 1, pend + 1); pend = 0;
          RB.live = (data.frame | 0) + 1;
          RB.steps++;
          var hk = data.hash || []; th = performance.now();
          for (var hi = 0; hi < hk.length; hi++) {
            hashes.push({ frame: hk[hi] | 0, hash: urHashAt((hk[hi] | 0) + 1) });
          }
          if (hk.length) { th = performance.now() - th; if (th > RB.maxHashMs) RB.maxHashMs = th; } else th = 0;
        } catch (e) { err = String((e && e.message) || e); QUIET = false; QUIET_AUDIO = false; }
        slowBurn(t0);
        var ms = performance.now() - t0;
        if (ms > RB.maxStepMs) RB.maxStepMs = ms;
        RB.hist[ms < 8 ? 0 : ms < 12 ? 1 : ms < 17 ? 2 : ms < 33 ? 3 : ms < 67 ? 4 : 5]++;
        // `sv`: this step's savestate cost per frame — the part of a rollback
        // step a delay frame does not pay (ps1.html adds it back to a delay
        // frame's run to estimate the rollback step it would cost).
        // `part`: where THIS step's wall time went — run (the presented frame's
        // _one_iter), resimRun / load (re-simulation and the undo restore),
        // save (every undo commit in the step; cmp = its dirty-page compare,
        // pages = pages logged), hash, and grew (heap / shadow / pool growth,
        // '' when none). So a burst in a room names its own cause. First use
        // (2026-10-04, MR2 loopback room, headless SwiftShader, 4 vCPU): of
        // 36-105 frames over 16.7 ms per run, 0-1 had a re-simulation and
        // 34-102 were `run`-dominated with ordinary saves and grew '' — the
        // core's own frame stretched 1.5-3x by CPU contention, not ring work.
        postMessage({ cmd: 'netFrame', frame: data.frame, ran: err ? 0 : 1, resim: resimRan, ms: ms, sv: (RB.saveMs - sv0) / (resimRan + 1), hashes: hashes, err: err, bytes: RB.lastBytes,
          part: { run: tp, resimRun: rr, load: ld, save: RB.saveMs - sv0, cmp: UR.stepCmpMs, pages: UR.stepPages, hash: th,
                  grew: (Module.HEAPU8.length !== hb0 ? 'heap ' : '') + (UR.top !== top0 ? 'shadow ' : '') + (UR.cap !== cap0 ? 'cap' : '') },
          logBytes: UR.logPages * PAGE, held: UR.oldest >= 0 ? UR.frame - UR.oldest : 0 });
        break;
      }
      // 'netIdle' {on: -1|0|1}: the exact idle-loop fast-forward (psxinterpreter.c
      // IDLE-LOOP FAST-FORWARD): read or set it, and its counters.
      case 'netIdle': {
        var ip = typeof _ps1_idle === 'function' ? _ps1_idle(data.on == null ? -1 : data.on | 0) >>> 0 : 0;
        var iv = ip ? Module.HEAPU32.subarray(ip >> 2, (ip >> 2) + 4) : null;
        postMessage({ cmd: 'netIdleResult', have: !!ip, on: iv ? iv[3] : null, skips: iv ? iv[0] : null, skippedKCycles: iv ? iv[1] : null });
        break;
      }
      case 'netRbStats': {
        postMessage({ cmd: 'netRbStatsResult', take: TAKE, why: TAKE_WHY, hz: coreHz, region: coreRegion,
          ring: RB.n, steps: RB.steps, resim: RB.resim, bytes: RB.lastBytes,
          saveMsAvg: (RB.steps + RB.resim) ? RB.saveMs / (RB.steps + RB.resim) : 0,
          runMsAvg: (RB.steps + RB.resim) ? RB.runMs / (RB.steps + RB.resim) : 0,
          loadMsTotal: RB.loadMs, maxStepMs: RB.maxStepMs, quietRenders: quietRenders, quietAudio: quietAudio,
          maxRunMs: RB.maxRunMs, maxSaveMs: RB.maxSaveMs, maxLoadMs: RB.maxLoadMs, maxHashMs: RB.maxHashMs, stepHist: RB.hist.slice(),
          gpuPal: Module.HEAP32[CORE.palFlag >> 2], gpuStat: Module.HEAP32[CORE.gpuStat >> 2] >>> 0, vmode: VMODE, vmodeSwitches: vmodeSwitches,
          ringBytes: urBytes(), shadowBytes: UR.cap, budget: RB.budget, maxLogBytes: UR.maxLogPages * PAGE, held: UR.oldest >= 0 ? UR.frame - UR.oldest : 0, cmpHow: UR.how, checkFails: UR.check ? UR.checkFails : null, track: URT ? URT.spans.map(function (x) { return x[2]; }).join(',') : null, trackMiss: UR.check && URT ? UR.checkMiss : null, trackMissAt: UR.check && URT ? UR.checkMissAt : null, trackPagesPerSave: UR.trackSaves ? UR.trackPages / UR.trackSaves : null, fullBytesPerSave: UR.trackSaves ? UR.fullBytes / UR.trackSaves : null, logPages: UR.logPages, poolPages: UR.pool.length,
          pagesPerSave: UR.saves ? UR.pages / UR.saves : 0, maxPagesPerSave: UR.maxPages, cmpMsAvg: UR.saves ? UR.cmpMs / UR.saves : 0,
          paceFrames: paceFrames, paceDrops: paceDrops, calls: schedCalls, remeasures: RB.remeasures | 0, merged: RB.merged | 0, rbMerge: RB_MERGE });
        break;
      }
      // Rig-only: a full-guest fingerprint of the LIVE state (same regions as
      // the rollback fingerprint), and a save/load round-trip timer.
      case 'netLiveHash': {
        postMessage({ cmd: 'netLiveHashResult', tag: data.tag, hash: liveHash(), calls: schedCalls });
        break;
      }
      case 'netAudioSab': {
        try {
          AR = { h: new Int32Array(data.sab, 0, 16), d: new Int16Array(data.sab, data.hdrBytes, data.cap * 2), cap: data.cap, mask: data.cap - 1 };
          AR.h[5] = GATE ? 1 : 0;
          postMessage({ cmd: 'netAudioSabOk' });
        } catch (e) { AR = null; postMessage({ cmd: 'print', txt: '[audio] ring refused: ' + e }); }
        break;
      }
      case 'netSnapMap': {
        var blk = (data.block | 0) || 65536, lo0 = SNAP_LO, hi0 = snapTop(), hs = [];
        var u32m = new Uint32Array(Module.HEAPU8.buffer);
        for (var a0 = lo0; a0 < hi0; a0 += blk) {
          var e0 = Math.min(hi0, a0 + blk), hh = 0x811c9dc5 | 0;
          for (var w0 = a0 >> 2; w0 < (e0 >> 2); w0++) hh = Math.imul(hh ^ u32m[w0], 16777619);
          hs.push(hh >>> 0);
        }
        if (!memMapTried) { memMapTried = true; try { memMap = locateMem(); } catch (e) { memMap = null; } }
        postMessage({ cmd: 'netSnapMapResult', lo: lo0, hi: hi0, block: blk, hashes: hs, mem: memMap, vram: vram_ptr, sb: soundbuffer_ptr, pad: padStatus1,
          R: memMap ? Module.HEAP32[(memMap.table >> 2) + 0x1fc0] >>> 0 : null });
        break;
      }
      case 'netSnapBench': {
        var reps = (data.reps | 0) || 20, sl = { buf: null, len: 0, fs: [] }, ts = [], tl2 = [];
        var h0 = liveHash();
        for (var bi = 0; bi < reps; bi++) {
          var a0 = performance.now(); snapSave(sl); var a1 = performance.now(); snapLoad(sl); var a2 = performance.now();
          ts.push(a1 - a0); tl2.push(a2 - a1);
        }
        var h1 = liveHash();
        postMessage({ cmd: 'netSnapBenchResult', bytes: sl.len, saveMs: ts, loadMs: tl2, same: h0 === h1, top: snapTop() });
        break;
      }

      case 'netSlow': {
        SLOW_R = Math.max(1, +data.r || 1);
        postMessage({ cmd: 'print', txt: '[rig] netSlow: every gated frame now costs ' + SLOW_R + 'x its own time' });
        break;
      }
      case 'netHash': {
        var r = stateHash();
        postMessage({ cmd: 'netHashResult', frame: data.frame, hash: r.hash, len: r.len, head: r.head || null, err: r.err || null });
        break;
      }

      // Reports whether the in-core frame limiter is actually live. If the
      // dfxvideo limiter never runs, `updated_display` stays -1 and one_iter
      // passes -1/1000 = 0 every time; a varying delay means FrameCap() is
      // setting it from gettimeofday.
      // Hand the core back to its own scheduler when a room ends. Without this a
      // gated core whose session went away is a permanently frozen console.
      case 'netUngate': {
        GATE = false;
        globalThis.__ps1NetGate = false;
        try { pcsx_mainloop(); } catch (e) {}
        postMessage({ cmd: 'netUngated' });
        break;
      }

      // Boot straight from bytes the harness hands us. This deliberately does
      // NOT use the page's romBegin/romChunk/romEnd path: that protocol has two
      // modes (lazy-URL and streaming-write), it is NOT what the checked-in
      // pcsx-wasm-src/js/worker_funcs.js describes, and a determinism probe has
      // no business depending on the disc loader. Both cores get identical bytes
      // by an identical path, which is the only thing the measurement needs.
      // pcsx_mainloop() is deliberately NOT called: under the gate the page
      // drives every frame, including the first.
      case 'netBoot': {
        try {
          var nb = new Uint8Array(data.buf);
          try { FS.unlink('/' + data.name); } catch (e) {}
          FS.createDataFile('/', data.name, nb, true, true);
          if (typeof _ps1_idle === 'function') _ps1_idle(/[?&]idle=0/.test(q) ? 0 : 1);
          pcsx_init('/' + data.name);
          padStatus1 = _get_ptr(-2);
          vram_ptr = _get_ptr(-1);
          soundbuffer_ptr = _get_ptr(7);
          isMute_ptr = _get_ptr(8);
          postMessage({ cmd: 'netBooted', ok: true, bytes: nb.length });
        } catch (e) {
          postMessage({ cmd: 'netBooted', ok: false, err: String((e && e.stack) || e) });
        }
        break;
      }

      // Diagnostic: read i32 words of the core's memory. Read-only; a rig uses
      // it to watch core globals (e.g. the dfxvideo PAL flag) without a
      // debugger, because CDP evaluate cannot interleave with this worker.
      case 'netPeek': {
        var out = [];
        try { var a = data.addrs || []; for (var k = 0; k < a.length; k++) out.push(Module.HEAP32[(a[k] >>> 0) >> 2]); } catch (e) { out = null; }
        postMessage({ cmd: 'netPeekResult', tag: data.tag, vals: out, calls: schedCalls });
        break;
      }

      case 'netSchedStats': {
        postMessage({
          cmd: 'netSchedStatsResult',
          gate: GATE, calls: schedCalls, nonZero: schedNonZero,
          min: schedCalls ? schedMin : null, max: schedCalls ? schedMax : null
        });
        break;
      }

      default: return origMain(event);
    }
  };

  var origPre = pre_onmessage;
  pre_onmessage = function (event) {
    var c = event.data && event.data.cmd;
    if (typeof c === 'string' && c.slice(0, 3) === 'net') return main_onmessage(event);
    return origPre(event);
  };
  if (self.onmessage === origPre) self.onmessage = pre_onmessage;

  globalThis.__ps1NetGate = GATE;
})();

/* ══ ONE PICTURE COPIES ONLY THE VRAM IT SHOWS ═══════════════════════════════
   render() used to copy 2 MB out of the heap for every picture — twice, on the
   SAB path: heap -> SAB here, SAB -> the page's heap in ps1.html renderTickNow.
   The page's only reader of that copy is its Blit32 (pcsx-wasm-src/gui/
   wwGUI.cc:16-57), which for column in [0,sy) reads VRAM halfword
   1024*(y+column)+x onward — sx halfwords, or sx*3 bytes when rgb24. So the
   bytes a picture can touch are ONE contiguous span:
       lo = 2*(1024*y + x),  hi = 2*(1024*(y+sy-1) + x) + sx*(rgb24 ? 3 : 2)
   which for MR2's 320x240 / 368x480 modes is ~0.5 / ~1 MB, not 2 MB. Bytes
   outside it are never read by the page, so leaving them stale changes no
   pixel. The span travels with the picture (SAB header words 8/9, or lo/hi on
   the 'render' message) and is read under the same seqlock as x/y/sx/sy.
   Presentation only: nothing here writes guest memory. ?vramcopy=full on the
   worker URL restores the whole 2 MB (the A/B arm). */
var VRAM_COPY_FULL=(function(){try{return /[?&]vramcopy=full\b/.test(String(self.location.search))}catch(e){return false}})();
function vramSpan(x,y,sx,sy,rgb24){
  var N=1024*2048;
  x|=0;y|=0;sx|=0;sy|=0;
  if(VRAM_COPY_FULL||x<0||y<0)return [0,N];
  if(sx<=0||sy<=0)return [0,0];
  var lo=2*(1024*y+x)&~3, hi=(2*(1024*(y+sy-1)+x)+sx*(rgb24?3:2)+3)&~3;
  if(lo>N)lo=N; if(hi>N)hi=N;
  return [lo,hi];
}
