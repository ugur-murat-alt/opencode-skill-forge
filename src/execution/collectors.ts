/** Audited artifact collectors run inside the existing sandbox, never on host input paths. */
export const NODE_COLLECTOR = `const fs=require('fs'),path=require('path');const out={};let total=0;function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('symlink');if(s.isDirectory())walk(p);else{if(!s.isFile()||s.nlink!==1||s.size>4194304||Object.keys(out).length>=256)throw Error('limit');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size>4194304)throw Error('unsafe');const b=fs.readFileSync(fd);total+=b.length;if(total>4194304)throw Error('limit');out[path.relative('/output',p)]=b.toString('base64');}finally{fs.closeSync(fd);}}}}walk('/output');process.stdout.write(JSON.stringify(out));`;
export const PYTHON_COLLECTOR = `import os,stat,json,base64
out={}; total=0
for root,dirs,files in os.walk('/output',followlinks=False):
 for name in dirs+files:
  if os.path.islink(os.path.join(root,name)): raise ValueError('symlink')
 for name in files:
  p=os.path.join(root,name); fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   s=os.fstat(fd)
   if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>4194304 or len(out)>=256: raise ValueError('limit')
   with os.fdopen(fd,'rb',closefd=False) as f: b=f.read(4194305)
   total+=len(b)
   if total>4194304: raise ValueError('limit')
   out[os.path.relpath(p,'/output')]=base64.b64encode(b).decode('ascii')
  finally: os.close(fd)
print(json.dumps(out))`;
