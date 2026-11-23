import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigMapWriteLock } from '../config-map-write-lock.js'
import { ComponentVersionOrder } from '../component-version-order.js'

describe('ConfigMapWriteLock', () =>
{
    it('runs the bodies for one object one after another, even when one fails; other objects do not wait', async () =>
    {
        const lock = new ConfigMapWriteLock()
        const order: string[] = []
        let releaseFirst: () => void = () => undefined
        const gate = new Promise<void>(resolve => { releaseFirst = resolve })
        const first = lock.Run('a', async () => { order.push('a1 start'); await gate; order.push('a1 end'); throw new Error('refused') })
        const second = lock.Run('a', async () => { order.push('a2') })
        const other = lock.Run('b', async () => { order.push('b') })
        await other
        assert.deepEqual(order, ['a1 start', 'b'], 'b ran while a1 held a')
        releaseFirst()
        await assert.rejects(first)
        await second
        assert.deepEqual(order, ['a1 start', 'b', 'a1 end', 'a2'])
    })
})

describe('ComponentVersionOrder', () =>
{
    it('orders versions by semver precedence', () =>
    {
        assert.equal(ComponentVersionOrder.IsNewer('0.2.4', '0.2.0'), true)
        assert.equal(ComponentVersionOrder.IsNewer('0.2.0', '0.2.4'), false)
        assert.equal(ComponentVersionOrder.IsNewer('0.2.4', '0.2.4'), false)
        assert.equal(ComponentVersionOrder.IsNewer('0.10.0', '0.9.9'), true)
        assert.equal(ComponentVersionOrder.IsNewer('1.0.0', '1.0.0-early.9'), true)
        assert.equal(ComponentVersionOrder.IsNewer('1.0.0-early.10', '1.0.0-early.9'), true)
        assert.equal(ComponentVersionOrder.IsNewer('dev', '0.1.0'), false)
    })
})
