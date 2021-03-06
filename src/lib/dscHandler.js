/**
 * Copyright 2018-2019 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;
const PRODUCTS = require('@f5devcentral/f5-cloud-libs').sharedConstants.PRODUCTS;

const doUtil = require('./doUtil');
const Logger = require('./logger');
const PATHS = require('./sharedConstants').PATHS;

const logger = new Logger(module);

/**
 * Handles DSC parts of a declaration.
 *
 * @class
 */
class DscHandler {
    /**
     * Constructor
     *
     * @param {Object} declaration - Parsed declaration.
     * @param {Object} bigIp - BigIp object.
     * @param {EventEmitter} - DO event emitter.
     * @param {State} - The doState.
     */
    constructor(declaration, bigIp, eventEmitter, state) {
        this.declaration = declaration;
        this.bigIp = bigIp;
        this.eventEmitter = eventEmitter;
        this.state = state;
    }

    /**
     * Starts processing.
     *
     * @returns {Promise} A promise which is resolved when processing is complete
     *                    or rejected if an error occurs.
     */
    process() {
        logger.fine('Processing DSC declaration.');
        logger.fine('Checking ConfigSync.');
        return handleConfigSync.call(this)
            .then(() => {
                logger.fine('Checking FailoverUnicast.');
                return handleFailoverUnicast.call(this);
            })
            .then(() => {
                logger.fine('Checking DeviceTrust and DeviceGroup.');
                return handleDeviceTrustAndGroup.call(this);
            })
            .catch((err) => {
                logger.severe(`Error processing DSC declaration: ${err.message}`);
                return Promise.reject(err);
            });
    }
}

/**
 * Handles creating the config sync IP
 */
function handleConfigSync() {
    if (this.declaration.Common.ConfigSync) {
        let configsyncIp = this.declaration.Common.ConfigSync.configsyncIp || 'none';

        // address may have been a json pointer to something with a CIDR
        // so strip that off
        const slashIndex = configsyncIp.indexOf('/');
        if (slashIndex !== -1) {
            configsyncIp = configsyncIp.substring(0, slashIndex);
        }

        return this.bigIp.cluster.configSyncIp(
            configsyncIp,
            cloudUtil.SHORT_RETRY
        );
    }
    return Promise.resolve();
}

/**
 * Handles setting the network failover unicast address
 */
function handleFailoverUnicast() {
    let body;
    if (this.declaration.Common.FailoverUnicast) {
        const port = this.declaration.Common.FailoverUnicast.port;
        let unicastAddress = this.declaration.Common.FailoverUnicast.address || 'none';

        if (unicastAddress === 'none') {
            body = {
                unicastAddress
            };
        } else {
            // address may have been a json pointer to something with a CIDR
            // so strip that off
            const slashIndex = unicastAddress.indexOf('/');
            if (slashIndex !== -1) {
                unicastAddress = unicastAddress.substring(0, slashIndex);
            }
            body = {
                unicastAddress: [
                    {
                        port,
                        ip: unicastAddress
                    }
                ]
            };
        }

        return this.bigIp.deviceInfo()
            .then(deviceInfo => this.bigIp.modify(
                `/tm/cm/device/~Common~${deviceInfo.hostname}`,
                body
            ))
            .catch((err) => {
                logger.severe(`Error setting failover unicast address: ${err.message}`);
                return Promise.reject(err);
            });
    }
    return Promise.resolve();
}

/**
 * Checks to see if we are joining a cluster. If so, process that as one big operation.
 * Otherwise, handle device trust and group separately.
 */
function handleDeviceTrustAndGroup() {
    if (this.declaration.Common.DeviceTrust && this.declaration.Common.DeviceGroup) {
        const deviceTrust = this.declaration.Common.DeviceTrust;
        const deviceGroupName = Object.keys(this.declaration.Common.DeviceGroup)[0];
        let deviceGroup;
        if (deviceGroupName) {
            deviceGroup = this.declaration.Common.DeviceGroup[deviceGroupName];
        }
        if (deviceGroup) {
            return this.bigIp.deviceInfo()
                .then((deviceInfo) => {
                    if (deviceInfo.hostname !== deviceGroup.owner) {
                        return isRemoteHost.call(this, deviceInfo, deviceTrust.remoteHost);
                    }
                    return Promise.resolve(true);
                })
                .then((isRemote) => {
                    if (!isRemote) {
                        logger.fine('Passing off to join cluster function.');
                        return handleJoinCluster.call(this);
                    }
                    // If this host is the remote host, we only create the device group and
                    // ignore device trust.
                    return handleDeviceGroup.call(this);
                })
                .catch((err) => {
                    logger.severe(`Error creating/joining device trust/group: ${err.message}`);
                    return Promise.reject(err);
                });
        }
    }

    return handleDeviceTrust.call(this)
        .then(() => handleDeviceGroup.call(this))
        .catch((err) => {
            logger.severe(`Error handling device trust and group: ${err.message}`);
            return Promise.reject(err);
        });
}

/**
 * Handles joining a cluster. There is a lot to this, especially when ASM is
 * provisioned. f5-cloud-libs has all the logic for this.
 */
function handleJoinCluster() {
    if (this.declaration.Common.DeviceTrust && this.declaration.Common.DeviceGroup) {
        const deviceTrust = this.declaration.Common.DeviceTrust;
        const deviceGroupName = Object.keys(this.declaration.Common.DeviceGroup)[0];
        const deviceGroupMembers = this.declaration.Common.DeviceGroup[deviceGroupName].members;

        this.bigIp.user = deviceTrust.localUsername;
        this.bigIp.password = deviceTrust.localPassword;
        return doUtil.checkDnsResolution(deviceTrust.remoteHost)
            .then(() => this.bigIp.cluster.joinCluster(
                deviceGroupName,
                deviceTrust.remoteHost,
                deviceTrust.remoteUsername,
                deviceTrust.remotePassword,
                false,
                {
                    product: PRODUCTS.BIGIP,
                    syncCompDevices: deviceGroupMembers
                }
            ))
            .then(() => pruneDeviceGroup.call(this, deviceGroupName, deviceGroupMembers));
    }
    return Promise.resolve();
}

/**
 * Handles setting up the device trust.
 */
function handleDeviceTrust() {
    if (this.declaration.Common.DeviceTrust) {
        const deviceTrust = this.declaration.Common.DeviceTrust;
        let deviceInfo;

        return this.bigIp.deviceInfo()
            .then((response) => {
                deviceInfo = response;
                return isRemoteHost.call(this, deviceInfo, deviceTrust.remoteHost);
            })
            .then((isRemote) => {
                // If we are not the remote, check to see if we need to request to be added
                if (!isRemote) {
                    return doUtil.checkDnsResolution(deviceTrust.remoteHost)
                        .then(() => doUtil.getBigIp(
                            logger,
                            {
                                host: deviceTrust.remoteHost,
                                user: deviceTrust.remoteUsername,
                                password: deviceTrust.remotePassword
                            }
                        ))
                        .then(remoteBigIp => remoteBigIp.cluster.addToTrust(
                            deviceInfo.hostname,
                            deviceInfo.managementAddress,
                            deviceTrust.localUsername,
                            deviceTrust.localPassword
                        ))
                        .then(() => this.bigIp.cluster.syncComplete())
                        .catch((err) => {
                            logger.severe(`Could not add to remote trust: ${err.message}`);
                            return Promise.reject(err);
                        });
                }
                return Promise.resolve();
            })
            .catch((err) => {
                logger.severe(`Error adding to trust: ${err.message}`);
                return Promise.reject(err);
            });
    }
    return Promise.resolve();
}

/**
 * Handles creating or joining the device group.
 */
function handleDeviceGroup() {
    if (this.declaration.Common.DeviceGroup) {
        const deviceGroupName = Object.keys(this.declaration.Common.DeviceGroup)[0];
        let deviceGroup;
        let deviceGroupMembers;
        if (deviceGroupName) {
            deviceGroup = this.declaration.Common.DeviceGroup[deviceGroupName];
            deviceGroupMembers = this.declaration.Common.DeviceGroup[deviceGroupName].members;
        }

        if (deviceGroup) {
            return this.bigIp.deviceInfo()
                .then((deviceInfo) => {
                    const hostname = deviceInfo.hostname;
                    // If we are the owner, create the group
                    if (hostname === deviceGroup.owner) {
                        return createDeviceGroup.call(this, deviceGroupName, deviceGroup);
                    }

                    return joinDeviceGroup.call(this, deviceGroupName, hostname)
                        .then(() => pruneDeviceGroup.call(this, deviceGroupName, deviceGroupMembers));
                })
                .catch((err) => {
                    logger.severe(`Error handling device group: ${err.message}`);
                    return Promise.reject(err);
                });
        }
    }

    return Promise.resolve();
}

/**
 * Creates a device group and syncs to it.
 *
 * @param {String} deviceGroupName - Name of the device gruop to create
 * @param {Object} deviceGroup - Device group from the declaration
 *
 * @returns {Promise} A promise which is resolved when the operation is complete
 *                    or rejected if an error occurs.
 */
function createDeviceGroup(deviceGroupName, deviceGroup) {
    let needsSync = false;

    // Get the device group members that are currently trusted
    return this.bigIp.cluster.areInTrustGroup(deviceGroup.members || [])
        .then((devices) => {
            // If we're adding something besides ourselves do
            // an initial sync after createion
            if (devices.length > 0) {
                needsSync = true;
            }

            return this.bigIp.cluster.createDeviceGroup(
                deviceGroupName,
                deviceGroup.type,
                devices,
                {
                    autoSync: deviceGroup.autoSync,
                    saveOnAutoSync: deviceGroup.saveOnAutoSync,
                    networkFailover: deviceGroup.networkFailover,
                    fullLoadOnSync: deviceGroup.fullLoadOnSync,
                    asmSync: deviceGroup.asmSync
                }
            );
        })
        .then(() => pruneDeviceGroup.call(this, deviceGroupName, deviceGroup.members)
            .then((pruned) => {
                needsSync = needsSync || pruned;
            }))
        .then(() => {
            if (needsSync) {
                // We are the owner, so sync to the group
                return this.bigIp.cluster.sync('to-group', deviceGroupName);
            }
            return Promise.resolve();
        })
        .then(() => this.bigIp.cluster.syncComplete(
            { maxRetries: 3, retryIntervalMs: 10000 },
            { connectedDevices: deviceGroup.members }
        ))
        .catch((err) => {
            logger.severe(`Error creating device group: ${err.message}`);
            return Promise.reject(err);
        });
}

/**
 * Joins and existing device group.
 *
 * Expects that the device group exists prior to calling.
 * Expects that if the declaration also has DeviceTrust info, syncying
 * is handled by the f5-cloud-libs joinCluster function.
 *
 * @param {String} deviceGroupName - Name of the device gruop to create
 * @param {Object} hostnamne - Hostname to add
 *
 * @returns {Promise} A promise which is resolved when the operation is complete
 *                    or rejected if an error occurs.
 */
function joinDeviceGroup(deviceGroupName, hostname) {
    // Wait till we have the device group. Once addToTrust is finished
    // and the owning device creates the group, we should have it but maybe
    // we are coming up before the owner, so wait.
    return waitForDeviceGroup.call(this, deviceGroupName)
        .then(() => this.bigIp.cluster.addToDeviceGroup(hostname, deviceGroupName))
        .catch((err) => {
            logger.severe(`Error joining device group: ${err.message}`);
            return Promise.reject(err);
        });
}

function waitForDeviceGroup(deviceGroupName) {
    function checkDeviceGroup() {
        return new Promise((resolve, reject) => {
            this.bigIp.cluster.hasDeviceGroup(deviceGroupName)
                .then((hasDeviceGroup) => {
                    if (hasDeviceGroup) {
                        resolve();
                    } else {
                        reject(new Error(`Device group ${deviceGroupName} does not exist on this device.`));
                    }
                });
        });
    }

    return cloudUtil.tryUntil(this, cloudUtil.SHORT_RETRY, checkDeviceGroup);
}

function isRemoteHost(deviceInfo, remoteHost) {
    return new Promise((resolve, reject) => {
        if (deviceInfo.hostname === remoteHost
            || deviceInfo.managementAddress === remoteHost) {
            resolve(true);
        } else {
            // Need to check self ips to see if any match
            this.bigIp.list(PATHS.SelfIp)
                .then((selfIps) => {
                    if (selfIps && Array.isArray(selfIps)) {
                        const match = selfIps.find(selfIp => doUtil.stripCidr(selfIp.address) === remoteHost);
                        resolve(!!match);
                    }
                })
                .catch((err) => {
                    logger.severe(`Error determining if we are remote host: ${err.message}`);
                    reject(err);
                });
        }
    });
}

/**
 * Removes unwanted devices from device group.
 *
 * @param {String} deviceGroupName - Name of the device group.
 * @param {String[]} deviceNames - Devices that should remain in device group.
 *
 * @returns {Promise} A promise which is resolved when the operation is complete
 *                    or rejected if an error occurs. Promise resolves with true
 *                    if one or more devices were pruned from the device group.
 */
function pruneDeviceGroup(deviceGroupName, deviceNames) {
    if (!Array.isArray(deviceNames)) {
        return Promise.resolve(false);
    }

    return this.bigIp.list(`${PATHS.DeviceGroup}/~Common~${deviceGroupName}/devices`)
        .then((devices) => {
            if (!Array.isArray(devices)) {
                return Promise.resolve(false);
            }

            const devicesToRemove = [];
            devices.forEach((device) => {
                if (deviceNames.indexOf(device.name) === -1) {
                    devicesToRemove.push(device.name);
                }
            });

            if (devicesToRemove.length === 0) {
                return Promise.resolve(false);
            }

            return this.bigIp.cluster.removeFromDeviceGroup(devicesToRemove, deviceGroupName)
                .then(() => Promise.resolve(true));
        });
}

module.exports = DscHandler;
