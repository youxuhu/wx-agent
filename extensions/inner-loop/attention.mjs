// Observe focus/mouse escape sequences before fullscreen consumes them. Never log keystrokes.
// No timer, OS/UI polling, terminal-mode changes or private TUI access.
export function observeTerminalAttention(onInterrupt,input=process.stdin){
 let focused=null,sequence='';
 const listener=data=>{
  for(const char of String(data)){
   if(char==='\x1b'){sequence=char;continue}
   if(!sequence)continue;
   sequence+=char;
   if(sequence.length===2){if(char!=='[')sequence='';continue}
   if(sequence.length>32){sequence='';continue}
   if(char>='@'&&char<='~'){
    if(sequence==='\x1b[O'){focused=false;onInterrupt('focus-out')}
    else if(sequence==='\x1b[I')focused=true;
    else if(sequence.startsWith('\x1b[<'))onInterrupt('mouse');
    sequence='';
   }
  }
 };
 const attached=input?.isTTY===true;
 if(attached)input.on('data',listener);
 return {get focused(){return focused},noteInteraction(){focused=true},dispose(){if(attached)input.off('data',listener);sequence=''}};
}
export const isTerminalRelease=data=>/^\x1b\[\d+;\d+:3(?:;[\d:]*)?u$/.test(data);
