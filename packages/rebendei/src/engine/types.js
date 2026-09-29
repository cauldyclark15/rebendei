/** @typedef {Record<string,any> & {_id:string,_creationTime:number}} Doc */
/** @typedef {{key:any[],inclusive:boolean}} Bound */
/** @typedef {{table:string,index:string,fields:string[],lower:Bound|null,upper:Bound|null}} Range */
/** @typedef {{ranges:Range[]}} ReadSet */
/** @typedef {{table:string,id:string,oldDoc:Doc|null,newDoc:Doc|null}} Write */
/** @typedef {import('bun').SQL|import('bun').TransactionSQL} Connection */
export {};
