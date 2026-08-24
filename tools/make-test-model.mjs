/**
 * Writes a tiny stand-in for a Piper voice (same input/output signature, a few
 * kilobytes instead of 60 MB) so the smoke test can exercise the whole
 * synthesis path without downloading a real model.
 *
 * Generated files are gitignored - they are test fixtures, not app content.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../public/test-assets/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const python = `
import onnx
from onnx import helper, TensorProto, numpy_helper
import numpy as np

# Same graph inputs Piper's VITS export uses, so the worker's feed dict is
# exercised exactly as it would be against a real voice.
inputs = [
    helper.make_tensor_value_info('input', TensorProto.INT64, [1, 'N']),
    helper.make_tensor_value_info('input_lengths', TensorProto.INT64, [1]),
    helper.make_tensor_value_info('scales', TensorProto.FLOAT, [3]),
]
output = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1, 'T'])

initializers = [
    numpy_helper.from_array(np.array([1, 800], dtype=np.int64), 'repeats'),
    numpy_helper.from_array(np.array(0.02, dtype=np.float32), 'gain'),
    numpy_helper.from_array(np.array([0], dtype=np.int64), 'axis0'),
]
nodes = [
    helper.make_node('Cast', ['input'], ['as_float'], to=TensorProto.FLOAT),
    helper.make_node('Sin', ['as_float'], ['wave']),
    helper.make_node('Mul', ['wave', 'gain'], ['quiet']),
    helper.make_node('Tile', ['quiet', 'repeats'], ['tiled']),
    helper.make_node('Unsqueeze', ['tiled', 'axis0'], ['output']),
]

graph = helper.make_graph(nodes, 'tiny-piper-stub', inputs, [output], initializers)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, '${outDir}tiny.onnx')
print('ok')
`;

execFileSync('python3', ['-c', python], { stdio: 'inherit' });

writeFileSync(
  `${outDir}tiny.onnx.json`,
  JSON.stringify(
    {
      audio: { sample_rate: 22050 },
      espeak: { voice: 'vi' },
      inference: { noise_scale: 0.667, length_scale: 1.0, noise_w: 0.8 },
      speaker_id_map: {},
      num_speakers: 1,
    },
    null,
    2,
  ),
);
console.log(`Wrote ${outDir}tiny.onnx (+ .json)`);
