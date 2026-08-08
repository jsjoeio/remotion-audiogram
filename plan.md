# Contexto

recién creamos el workflow de github para crear los podcasts. parece un poco
diferente al workflow del script local de bun run podcast que usamos.

algo que noté es que los subtítulos parecen un poco no alineados con el audio.

me pregunto si podemos arreglar el workflow de github y abrir un PR? 

no hace falta correr el workflow solo quiero que compares los dos workflows para
identificar el problema. en nuestro script primero detectamos cuando empieza el
audio y usamos eso en el flow de whisper. quizás necesitamos hacer lo mismo con
el github action que estámos usando?

## Fix (implemented)

**Causa:** local recorta el silencio inicial antes de Whisper y re-suma ese
offset a los captions; CI mandaba el WAV completo a whisper-action y no
desplazaba el SRT.

**Cambio:**
1. `podcast:prepare` — `detectSpeechStart` + `.cache/dialogue-whisper.wav` +
   `.cache/speech-start.json`
2. workflow — `audio_path: .cache/dialogue-whisper.wav`
3. `srt-to-captions` — shift por el offset de speech-start (igual que local)
