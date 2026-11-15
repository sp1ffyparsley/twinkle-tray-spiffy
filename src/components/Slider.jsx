import React from "react";
import { useEffect, Component } from "react"
import PropTypes from 'prop-types';
const { POSITION_STEPS, positionFromLevel, levelFromPosition, keyboardLevel } = require('../BrightnessScale')

export default class Slider extends Component {

    firingEvent = false
    handleChange = (event) => {
        const level = event.target.type === 'range' && this.isZeroCentered()
            ? levelFromPosition(event.target.value, this.props.min, this.props.max, true)
            : this.cap(event.target.value)
        if(level !== this.state.level)
            this.setState({ level, numberDraft: null }, this.fireChange)
    }
    // Editing a numeric field is not a brightness command. An empty field
    // previously coerced to zero and wrote a display value before the user
    // could finish replacing it.
    handleNumberChange = (event) => {
        if (!this.props.disabled) this.setState({ numberDraft: event.target.value })
    }
    commitNumber = () => {
        const draft = this.state.numberDraft
        if (draft === null) return
        const numeric = Number(draft)
        if (String(draft).trim() === '' || !Number.isFinite(numeric)) {
            this.setState({ numberDraft: null })
            return
        }
        const level = this.cap(Math.round(numeric))
        const changed = level !== this.state.level
        this.setState({ level, numberDraft: null }, changed ? this.fireChange : undefined)
    }
    handleNumberKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            this.setState({ numberDraft: null })
        } else if (event.key === 'Enter') {
            event.preventDefault()
            this.commitNumber()
        }
    }

    handleWheel = (event) => {
        if (this.props.disabled || this.props.scrolling === false) return false;
        this.setState({ level: this.cap((this.state.level * 1) + Math.round(event.deltaY * -1 * 0.01 * (this.props.scrollAmount ?? 1))), numberDraft: null }, this.fireChange)
    }

    fireChange = () => {
        if (this.firingEvent === false && this.props.onChange && typeof this.props.onChange == "function") {
            this.firingEvent = true
            try {
                this.props.onChange(this.cap(this.state.level) * 1, this)
            } finally {
                this.firingEvent = false
            }
        }
    }

    getName = () => {
        if (this.props.name) {
            return (
                <div className="name-row">
                    <div className="icon" style={{display: (this.props.icon === false ? "none" : "block")}}>{(this.props.monitortype == "wmi" ? <span>&#xE770;</span> : <span>&#xE7F4;</span>)}</div>
                    <div className="title">{this.props.name}</div>
                    {this.props.afterName}
                </div>
            )
        }
    }

    cap = (level) => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        let capped = level * 1
        if (level < min) {
            capped = min
        } else if (level > max) {
            capped = max
        }
        return capped
    }

    handleRangeKeyDown = (event) => {
        if (!this.isZeroCentered() || this.props.disabled) return
        const next = keyboardLevel(this.state.level, event.key, this.props.min, this.props.max)
        if (next === undefined) return
        event.preventDefault()
        if (next !== this.state.level) this.setState({ level: next, numberDraft: null }, this.fireChange)
    }

    isZeroCentered = () => this.props.zeroCentered === true && this.props.min < 0 && this.props.max > 0

    progressStyle = () => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const level = this.cap((this.props.level || 0) * 1)
        const fraction = this.isZeroCentered()
            ? positionFromLevel(level, min, max, true) / POSITION_STEPS
            : (level - min) / (max - min)
        return { width: (fraction * 100) + "%" }
    }

    constructor(props) {
        super(props);
        this.state = {
            level: this.cap((this.props.level === undefined ? 50 : this.props.level)),
            numberDraft: null,
        }
        //this.fireChange()
    }

    componentDidUpdate(oldProps) {
        if (oldProps.max != this.props.max || oldProps.min != this.props.min || oldProps.level != this.props.level) {
            this.setState({
                level: this.cap(this.props.level),
                numberDraft: null
            })
        }
    }

    render() {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const level = this.cap(this.props.level)
        const centered = this.isZeroCentered()
        return (
            <div className="monitor-item" style={this.props.accentColor ? { '--slider-accent': this.props.accentColor } : undefined} onWheel={this.handleWheel}>
                {this.getName()}
                <div className="input--range" data-height={this.props.height}>
                    <div className="rangeGroup">
                        <input type="range" aria-label={this.props.name || 'Brightness'} disabled={this.props.disabled} min={centered ? 0 : min} max={centered ? POSITION_STEPS : max} value={centered ? positionFromLevel(level, min, max, true) : level} data-percent={level + "%"} onChange={this.handleChange} onKeyDown={this.handleRangeKeyDown} className="range" />
                        <div className="progress" style={this.progressStyle()}></div>
                    </div>
                    <input type="number" aria-label={(this.props.name || 'Brightness') + ' value'} disabled={this.props.disabled} min={min} max={max} step={1} value={this.state.numberDraft === null ? Math.floor(level) : this.state.numberDraft} onChange={this.handleNumberChange} onBlur={this.commitNumber} onKeyDown={this.handleNumberKeyDown} className="val" />
                </div>
            </div>
        );
    }

};
