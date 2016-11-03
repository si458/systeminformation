'use strict';
// ==================================================================================
// index.js
// ----------------------------------------------------------------------------------
// Description:   System Information - library
//                for Node.js
// Copyright:     (c) 2014 - 2016
// Author:        Sebastian Hildebrandt
// ----------------------------------------------------------------------------------
// License:       MIT
// ==================================================================================
// 13. Docker
// ----------------------------------------------------------------------------------

const os = require('os');
const util = require('./util');
const  DockerSocket = require('./dockerSocket');

let _platform = os.type();

const _windows = (_platform == 'Windows_NT');
const NOT_SUPPORTED = 'not supported';

var _docker_container_stats = {};
var _docker_socket;


// --------------------------
// get containers (parameter all: get also inactive/exited containers)

function dockerContainers(all, callback) {

  function inContainers(containers, id) {
    let filtered = containers.filter(obj => {
      /**
       * @namespace
       * @property {string}  Id
       */
      return (obj.Id && (obj.Id == id))
    });
    return (filtered.length > 0);
  }

  // fallback - if only callback is given
  if (util.isFunction(all) && !callback) {
    callback = all;
    all = false;
  }

  all = all || false;
  var result = [];
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      if (_windows) {
        let error = new Error(NOT_SUPPORTED);
        if (callback) { callback(NOT_SUPPORTED) }
        reject(error);
      }

      if (!_docker_socket) {
        _docker_socket = new DockerSocket();
      }

      _docker_socket.listContainers(all, data => {
        var docker_containers = {};
        // let cmd = "curl --unix-socket /var/run/docker.sock http:/containers/json" + (all ? "?all=1" : "");
        // exec(cmd, function (error, stdout) {
        //   if (!error) {
        try {
          //       let jsonString = stdout.toString();
          //       var docker_containers = JSON.parse(jsonString);
          docker_containers = data;
          if (docker_containers && Object.prototype.toString.call(docker_containers) === '[object Array]' && docker_containers.length > 0) {
            docker_containers.forEach(function (element) {
              /**
               * @namespace
               * @property {string}  Id
               * @property {string}  Name
               * @property {string}  Image
               * @property {string}  ImageID
               * @property {string}  Command
               * @property {number}  Created
               * @property {string}  State
               * @property {Array}  Names
               * @property {Array}  Ports
               * @property {Array}  Mounts
               */

              if (element.Names && Object.prototype.toString.call(element.Names) === '[object Array]' && element.Names.length > 0) {
                element.Name = element.Names[0].replace(/^\/|\/$/g, '');
              }
              result.push({
                id: element.Id,
                name: element.Name,
                image: element.Image,
                imageID: element.ImageID,
                command: element.Command,
                created: element.Created,
                state: element.State,
                ports: element.Ports,
                mounts: element.Mounts,
                // hostconfig: element.HostConfig,
                // network: element.NetworkSettings
              })
            });
          }
        } catch (err) {
        }
        // }

        // GC in _docker_container_stats
        for (var key in _docker_container_stats) {
          if (_docker_container_stats.hasOwnProperty(key)) {
            if (!inContainers(docker_containers, key)) delete _docker_container_stats[key];
          }
        }
        if (callback) { callback(result) }
        resolve(result);
      });
    });
  });
}

exports.dockerContainers = dockerContainers;

// --------------------------
// helper functions for calculation of docker stats

function docker_calcCPUPercent(cpu_stats, id) {
  /**
   * @namespace
   * @property {object}  cpu_usage
   * @property {number}  cpu_usage.total_usage
   * @property {number}  system_cpu_usage
   * @property {object}  cpu_usage
   * @property {Array}  cpu_usage.percpu_usage
   */

  var cpuPercent = 0.0;
  // calculate the change for the cpu usage of the container in between readings
  var cpuDelta = cpu_stats.cpu_usage.total_usage - (_docker_container_stats[id] && _docker_container_stats[id].prev_CPU ? _docker_container_stats[id].prev_CPU : 0);
  // calculate the change for the entire system between readings
  var systemDelta = cpu_stats.system_cpu_usage - (_docker_container_stats[id] && _docker_container_stats[id].prev_system ? _docker_container_stats[id].prev_system : 0);

  if (systemDelta > 0.0 && cpuDelta > 0.0) {
    cpuPercent = (cpuDelta / systemDelta) * cpu_stats.cpu_usage.percpu_usage.length * 100.0;
  }
  if (!_docker_container_stats[id]) _docker_container_stats[id] = {};
  _docker_container_stats[id].prev_CPU = cpu_stats.cpu_usage.total_usage;
  _docker_container_stats[id].prev_system = cpu_stats.system_cpu_usage;

  return cpuPercent
}

function docker_calcNetworkIO(networks) {
  var rx;
  var tx;
  for (var key in networks) {
    // skip loop if the property is from prototype
    if (!networks.hasOwnProperty(key)) continue;

    /**
     * @namespace
     * @property {number}  rx_bytes
     * @property {number}  tx_bytes
     */
    var obj = networks[key];
    rx = +obj.rx_bytes;
    tx = +obj.tx_bytes;
  }
  return {
    rx: rx,
    tx: tx
  }
}

function docker_calcBlockIO(blkio_stats) {
  let result = {
    r: 0,
    w: 0
  };

  /**
   * @namespace
   * @property {Array}  io_service_bytes_recursive
   */
  if (blkio_stats && blkio_stats.io_service_bytes_recursive && Object.prototype.toString.call(blkio_stats.io_service_bytes_recursive) === '[object Array]' && blkio_stats.io_service_bytes_recursive.length > 0) {
    blkio_stats.io_service_bytes_recursive.forEach(function (element) {
      /**
       * @namespace
       * @property {string}  op
       * @property {number}  value
       */

      if (element.op && element.op.toLowerCase() == 'read' && element.value) {
        result.r += element.value;
      }
      if (element.op && element.op.toLowerCase() == 'write' && element.value) {
        result.w += element.value;
      }
    })
  }
  return result;
}

// --------------------------
// container Stats (for one container)

function dockerContainerStats(containerID, callback) {
  containerID = containerID || '';
  var result = {
    id: containerID,
    mem_usage: 0,
    mem_limit: 0,
    mem_percent: 0,
    cpu_percent: 0,
    pids: 0,
    netIO: {
      rx: 0,
      wx: 0
    },
    blockIO: {
      r: 0,
      w: 0
    }
  };
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      if (_windows) {
        let error = new Error(NOT_SUPPORTED);
        if (callback) { callback(NOT_SUPPORTED) }
        reject(error);
      }
      if (containerID) {

        if (!_docker_socket) {
          _docker_socket = new DockerSocket();
        }

        _docker_socket.getStats(containerID, data => {
          // let cmd = "curl --unix-socket /var/run/docker.sock http:/containers/" + containerID + "/stats?stream=0";
          // exec(cmd, function (error, stdout) {
          //   if (!error) {
          //     let jsonString = stdout.toString();
          try {
//              let stats = JSON.parse(jsonString);
            let stats = data;
            /**
             * @namespace
             * @property {Object}  memory_stats
             * @property {number}  memory_stats.usage
             * @property {number}  memory_stats.limit
             * @property {Object}  cpu_stats
             * @property {Object}  pids_stats
             * @property {number}  pids_stats.current
             * @property {Object}  networks
             * @property {Object}  blkio_stats
             */

            if (!stats.message) {
              result.mem_usage = (stats.memory_stats && stats.memory_stats.usage ? stats.memory_stats.usage : 0);
              result.mem_limit = (stats.memory_stats && stats.memory_stats.limit ? stats.memory_stats.limit : 0);
              result.mem_percent = (stats.memory_stats && stats.memory_stats.usage && stats.memory_stats.limit ? stats.memory_stats.usage / stats.memory_stats.limit * 100.0 : 0);
              result.cpu_percent = (stats.cpu_stats ? docker_calcCPUPercent(stats.cpu_stats, containerID) : 0);
              result.pids = (stats.pids_stats && stats.pids_stats.current ? stats.pids_stats.current : 0);
              if (stats.networks) result.netIO = docker_calcNetworkIO(stats.networks);
              if (stats.blkio_stats) result.blockIO = docker_calcBlockIO(stats.blkio_stats);
              result.cpu_stats = (stats.cpu_stats ? stats.cpu_stats : {});
              result.precpu_stats = (stats.precpu_stats ? stats.precpu_stats : {});
              result.memory_stats = (stats.memory_stats ? stats.memory_stats : {});
              result.networks = (stats.networks ? stats.networks : {});
            }
          } catch (err) {
          }
          // }
          if (callback) { callback(result) }
          resolve(result);
        });
      } else {
        if (callback) { callback(result) }
        resolve(result);
      }
    });
  });
}

exports.dockerContainerStats = dockerContainerStats;

function dockerAll(callback) {
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      if (_windows) {
        let error = new Error(NOT_SUPPORTED);
        if (callback) { callback(NOT_SUPPORTED) }
        reject(error);
      }
      dockerContainers(true).then(result => {
        if (result && Object.prototype.toString.call(result) === '[object Array]' && result.length > 0) {
          var l = result.length;
          result.forEach(function (element) {
            dockerContainerStats(element.id).then(res => {
              // include stats in array
              element.mem_usage = res.mem_usage;
              element.mem_limit = res.mem_limit;
              element.mem_percent = res.mem_percent;
              element.cpu_percent = res.cpu_percent;
              element.pids = res.pids;
              element.netIO = res.netIO;
              element.blockIO = res.blockIO;
              element.cpu_stats = res.cpu_stats;
              element.precpu_stats = res.precpu_stats;
              element.memory_stats = res.memory_stats;
              element.networks = res.networks;

              // all done??
              l -= 1;
              if (l == 0) {
                if (callback) { callback(result) }
                resolve(result);
              }
            })
          })
        } else {
          if (callback) { callback(result) }
          resolve(result);
        }
      })
    });
  });
}

exports.dockerAll = dockerAll;