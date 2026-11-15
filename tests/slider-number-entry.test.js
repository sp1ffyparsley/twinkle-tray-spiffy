const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const babel = require('@babel/core')

const source = path.resolve(__dirname, '../src/components/Slider.jsx')
const transformed = babel.transformFileSync(source, {
  babelrc: false,
  configFile: false,
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react']
}).code
const loaded = new Module(source, module)
loaded.filename = source
loaded.paths = Module._nodeModulePaths(path.dirname(source))
loaded._compile(transformed, source)
const Slider = loaded.exports.default

function setup(level = 55) {
  const calls = []
  const instance = new Slider({
    id: 'test-monitor', min: -100, max: 200, zeroCentered: true, level,
    name: 'Test display', onChange: value => calls.push(value)
  })
  instance.setState = (update, callback) => {
    Object.assign(instance.state, typeof update === 'function' ? update(instance.state) : update)
    callback?.()
  }
  const controls = () => {
    const children = []
    function visit(element) {
      if (!element || typeof element !== 'object') return
      if (element.type === 'input') children.push(element)
      const nested = element.props?.children
      for (const child of Array.isArray(nested) ? nested : [nested]) visit(child)
    }
    visit(instance.render())
    return Object.fromEntries(children.map(child => [child.props.type, child.props]))
  }
  return { instance, calls, controls }
}

test('clearing and typing a numeric brightness value causes no intermediate hardware write', () => {
  const { instance, calls, controls } = setup()
  controls().number.onChange({ target: { value: '' } })
  controls().number.onChange({ target: { value: '1' } })
  controls().number.onChange({ target: { value: '120' } })
  assert.deepEqual(calls, [], 'No display write until the number is committed')
  assert.equal(controls().number.value, '120')
  controls().number.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(calls, [120])
  assert.equal(instance.state.level, 120)
})

test('empty, invalid, Escape and bounded numeric entries preserve user intent', () => {
  const { calls, controls } = setup(35)
  controls().number.onChange({ target: { value: '' } })
  controls().number.onBlur()
  assert.deepEqual(calls, [])
  controls().number.onChange({ target: { value: '-' } })
  controls().number.onBlur()
  assert.deepEqual(calls, [])
  controls().number.onChange({ target: { value: '-90' } })
  controls().number.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.deepEqual(calls, [])
  controls().number.onChange({ target: { value: '300' } })
  controls().number.onBlur()
  assert.deepEqual(calls, [200])
})

test('range control stays immediate and a failing callback does not freeze later brightness changes', () => {
  const { instance, controls, calls } = setup(0)
  controls().range.onChange({ target: { type: 'range', value: '750' } })
  assert.deepEqual(calls, [100])
  instance.props.onChange = () => { throw new Error('temporary callback failure') }
  assert.throws(() => controls().range.onChange({ target: { type: 'range', value: '800' } }), /temporary callback/)
  instance.props.onChange = value => calls.push(value)
  controls().range.onChange({ target: { type: 'range', value: '820' } })
  assert.deepEqual(calls, [100, 128])
})
