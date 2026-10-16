import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CREATIVE_LIBRARY_KEY,loadCreativeLibrary,saveJobMetadata,jobMetadata,matchesLibraryFilter} from '../../studio/src/creativeLibrary.mjs';
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};};
test('collections and favorites survive restart and preserve separate image/video identities',()=>{
  const storage=memory();
  let saved=saveJobMetadata(storage,{},'image','same',{collection:' Launch ',favorite:true});
  saved=saveJobMetadata(storage,saved.library,'video','same',{collection:'Other',sourceImageJobId:'same'});
  const library=loadCreativeLibrary(storage);
  assert.equal(jobMetadata(library,'image','same').collection,'Launch');
  assert.equal(jobMetadata(library,'video','same').sourceImageJobId,'same');
  assert.equal(matchesLibraryFilter(library,'image','same','favorites'),true);
  assert.equal(matchesLibraryFilter(library,'video','same','favorites'),false);
  assert.equal(matchesLibraryFilter(library,'image','same','collection:Launch'),true);
  assert.equal(matchesLibraryFilter(library,'image','same','unfiled'),false);
});
test('metadata stores no media, secrets or arbitrary fields and caps records',()=>{
  const storage=memory();let library={};
  for(let i=0;i<150;i++) library=saveJobMetadata(storage,library,'video',`job_${i}`,{sourceImageJobId:'image_1',apiKey:'SECRET',path:'/private/a',dataUrl:'data:SECRET'}).library;
  assert.equal(Object.keys(loadCreativeLibrary(storage)).length,128);
  assert.doesNotMatch(storage.getItem(CREATIVE_LIBRARY_KEY),/SECRET|\/private|dataUrl/);
  assert.equal(saveJobMetadata(storage,library,'other','a',{}).persisted,false);
});
test('malformed storage and unavailable persistence do not break history controls',()=>{
  const storage=memory();storage.setItem(CREATIVE_LIBRARY_KEY,JSON.stringify({version:1,entries:[null,['image:valid',{collection:'Valid'}],['bad',{}]]}));
  assert.equal(jobMetadata(loadCreativeLibrary(storage),'image','valid').collection,'Valid');
  const saved=saveJobMetadata({setItem(){throw Error('quota');}}, {}, 'image','job',{favorite:true});
  assert.equal(saved.persisted,false);assert.equal(saved.library['image:job'].favorite,true);
  assert.deepEqual(loadCreativeLibrary({getItem(){throw Error('blocked');}}),{});
});
