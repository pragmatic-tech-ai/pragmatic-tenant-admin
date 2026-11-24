import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../tenant-api-client.js'
import { ConsoleAddressOptionDto, EnrolmentLevel } from '../../../tenant-types.js'
import { FakeTenantApi, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { ConnectHiveViewModel, ConnectRefusal } from '../connect-hive-view-model.js'
import { ConnectionPageViewModel } from '../connection-page-view-model.js'

class ConnectFixture
{
    public static readonly Code = 'pe1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'

    public static NotEnrolledApi(option: ConsoleAddressOptionDto = ConsoleAddressOptionDto.OwnDomain, host?: string): FakeTenantApi
    {
        const api = new FakeTenantApi()
        api.FailOn.set('GetRollout', new ApiError(503, 'not connected yet', 'hive-not-enrolled'))
        api.Enrolment = FakeTenantApi.NotEnrolled(option, host)
        return api
    }
}

describe('ConnectHiveViewModel', () =>
{
    it('the agent\'s codes map to the fixed messages', () =>
    {
        assert.equal(ConnectHiveViewModel.MessageFor(new ApiError(422, 'refused', ConnectRefusal.Mismatch)), 'This code was issued for another tenant or level.')
        assert.equal(ConnectHiveViewModel.MessageFor(new ApiError(409, 'refused', ConnectRefusal.KeyRegistered)), "This hive's key is already registered with Pragmatic. Contact Pragmatic support.")
        for (const code of Object.values(ConnectRefusal))
        {
            const message = ConnectHiveViewModel.MessageFor(new ApiError(409, 'refused', code))
            assert.equal(message, ConnectHiveViewModel.Messages[code])
            assert.ok(!message.includes('refused'))
        }
        assert.equal(ConnectHiveViewModel.MessageFor(new ApiError(503, 'anything the server said', 'something-new')), ConnectHiveViewModel.Messages[ConnectRefusal.Unavailable])
        assert.equal(ConnectHiveViewModel.MessageFor(new ApiError(403, 'Forbidden')), ConnectHiveViewModel.ForbiddenMessage)
        assert.equal(ConnectHiveViewModel.MessageFor(new Error('network')), ConnectHiveViewModel.Messages[ConnectRefusal.Unavailable])
    })

    it('after enrolment the page shows hive id and level and the form is gone', async () =>
    {
        const api = ConnectFixture.NotEnrolledApi()
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.IsNotEnrolled, true)
        const connect = page.Connect
        assert.ok(connect !== undefined)
        assert.equal(connect.ShowsForm, true)
        assert.equal(connect.ConnectCommand.CanExecute(), false, 'no code yet')
        assert.match(connect.ConsoleAddressText, /console\.acme\.test \(your own domain\)/)
        connect.Code = ' ' + ConnectFixture.Code + ' '
        connect.SelectedLevel = connect.Levels.ToArray()[1]!
        assert.match(connect.LevelHelp, /without asking first/)
        assert.equal(connect.ConnectCommand.CanExecute(), true)
        await connect.Connect()
        assert.deepEqual(api.Enrolled, [{ Code: ConnectFixture.Code, Level: EnrolmentLevel.Delegated }])
        assert.equal(connect.ShowsForm, false)
        assert.match(connect.ConnectedText, /hvabcdefghij/)
        assert.match(connect.ConnectedText, /delegated/)
        await page.Refresh()
        assert.equal(page.IsEnrolled, true)
        assert.equal(page.IsNotEnrolled, false)
        assert.equal(page.HasConnect, false, 'the form is gone')
        assert.equal(page.StatusLabel, 'Connected')
        assert.match(page.Headline, /hvabcdefghij \(delegated\)/)
    })

    it('a refused code shows its fixed message and keeps the form', async () =>
    {
        const api = ConnectFixture.NotEnrolledApi()
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        api.FailOn.set('EnrolHive', new ApiError(422, 'refused', 'mismatch'))
        const connect = page.Connect!
        connect.Code = ConnectFixture.Code
        await connect.Connect()
        assert.equal(connect.ErrorText, 'This code was issued for another tenant or level.')
        assert.equal(connect.ShowsForm, true)
        assert.equal(connect.IsBusy, false)
    })

    it('the plain hive subdomain needs the ingress address before Connect is enabled', async () =>
    {
        const api = ConnectFixture.NotEnrolledApi(ConsoleAddressOptionDto.HiveSubdomain, 'acme.hives.pragmatic-tech.ai')
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        const connect = page.Connect!
        assert.equal(connect.NeedsIngressAddress, true)
        connect.Code = ConnectFixture.Code
        assert.equal(connect.ConnectCommand.CanExecute(), false)
        connect.IngressAddress = '203.0.113.7'
        assert.equal(connect.ConnectCommand.CanExecute(), true)
        await connect.Connect()
        assert.deepEqual(api.Enrolled, [{ Code: ConnectFixture.Code, Level: EnrolmentLevel.Enrolled, IngressAddress: '203.0.113.7' }])
    })

    it('Standalone has no connect page', async () =>
    {
        const api = new FakeTenantApi()
        api.FailOn.set('GetRollout', new ApiError(404, 'This hive runs standalone', 'engine-standalone'))
        api.Enrolment = FakeTenantApi.NotEnrolled()
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.IsStandalone, true)
        assert.equal(page.HasConnect, false)
        assert.equal(api.Calls.some(call => call[0] === 'GetEnrolment'), false)
    })

    it('a console with no enrolment routes (404) offers no form', async () =>
    {
        const api = new FakeTenantApi()
        api.FailOn.set('GetRollout', new ApiError(503, 'not connected yet', 'hive-not-enrolled'))
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.IsNotEnrolled, true)
        assert.equal(page.HasConnect, false)
    })
})
