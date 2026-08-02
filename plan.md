ahora estoy listo para el próximo paso de automatizar el proceso de crear un
podcast.

en este momento tenemos el podcast script. pero ahora el proceso es:
1. grabar podcST y mandar al bot de telegram
2. ir a mi compu, hacer bun run podcast

entonces quiero que agregamos un github workflow con la habilidad de 
hacer workflow dispatch 

preguntas abierta:
1. se puede inciar un github workflow por un API request? (como del telegram bot
   como un side effect? podés ver el telegram handler en ../jsjoe.io/workers/telegram-webhook/)
2. vale la pena hacer una acción entera como "bun run podcast" o vale la pena
   separar las acciones en el github worklow? me imagino separar para poder
cache el whisper build? pero no sé.

podés investgar y escribir un plan-grok.md acá? no lo implementamos hoy,
escribílo en inglés acá en esta carpeta. lo hacemos otro día.
